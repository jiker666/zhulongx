package dasctf

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

// Goal-title prefix marking a goal imported from the DASCTF platform.
// "dasctf:<exerciseId>" — one exercise maps to exactly one goal.
const TitlePrefix = "dasctf:"

// Actor used in audit rows written by the sync loop and the gate.
const ActorSync = "dasctf:sync"

func goalTitle(id int) string { return TitlePrefix + strconv.Itoa(id) }

// CodeOfTitle reports the exercise ID of a DASCTF goal title.
func CodeOfTitle(title string) (int, bool) {
	if !strings.HasPrefix(title, TitlePrefix) {
		return 0, false
	}
	id, err := strconv.Atoi(strings.TrimPrefix(title, TitlePrefix))
	if err != nil {
		return 0, false
	}
	return id, true
}

// Import creates one goal per open platform exercise that has no local
// goal yet. The goal's origin carries the full combat brief (exercise
// facts + API quick reference + operating constraints); the objective
// names the platform's own completion criterion. Repeat runs are
// idempotent.
//
// priority lists exercise IDs to import FIRST: the engine schedules goals
// in creation order, so the likely-convertible titles head the queue.
// Without a priority file the category rank (WEB, CRYPTO, MISC, PWN,
// REVERSE) sets the default order.
func Import(ctx context.Context, st *store.Store, c *Client, priority []int) (created int, err error) {
	exercises, err := c.List(ctx)
	if err != nil {
		return 0, err
	}
	open := make([]Exercise, 0, len(exercises))
	for _, ex := range exercises {
		if ex.IsOpen {
			open = append(open, ex)
		}
	}
	existing := make(map[int]bool)
	goals, err := st.ListGoals(ctx)
	if err != nil {
		return 0, err
	}
	for _, g := range goals {
		if id, ok := CodeOfTitle(g.Title); ok {
			existing[id] = true
		}
	}
	details := make(map[int]*Detail, len(open))
	for _, ex := range open {
		if existing[ex.ID] {
			continue
		}
		d, err := c.Detail(ctx, ex.ID)
		if err != nil {
			// A detail hiccup must not sink the whole import: briefs
			// degrade to list-level facts.
			d = nil
		}
		details[ex.ID] = d
	}
	ordered := sortByPriority(open, priority)
	for _, ex := range ordered {
		if existing[ex.ID] {
			continue
		}
		g, err := st.CreateGoal(ctx, goalTitle(ex.ID), Brief(c, ex, details[ex.ID]), Objective(ex))
		if err != nil {
			return created, fmt.Errorf("dasctf: create goal for %d: %w", ex.ID, err)
		}
		// Bootstrap fact: the step contract requires a non-empty source
		// (from), and a fresh goal has no facts for Decide to anchor the
		// first step on. Origin/objective are goal fields here, not
		// facts, so import must seed the anchor itself.
		if _, err := st.AddHumanFact(ctx, g.ID,
			"bootstrap: DASCTF 平台题目已就绪。作战简报(题目信息、附件、平台 API 速查、约束与完成判据)见本目标 origin 字段。从此事实出发建第一个步骤。",
			ActorSync); err != nil {
			return created, fmt.Errorf("dasctf: bootstrap fact for %d: %w", ex.ID, err)
		}
		created++
	}
	return created, nil
}

// categoryRank orders the default import queue: container-backed web
// exploitation first (the engine's specialty, and the env build starts
// early), then offline analysis, binary work last — binary categories
// historically convert slowest per minute of slot time.
func categoryRank(cat string) int {
	switch strings.ToUpper(strings.TrimSpace(cat)) {
	case "WEB":
		return 0
	case "CRYPTO":
		return 1
	case "MISC":
		return 2
	case "PWN":
		return 3
	case "REVERSE":
		return 4
	}
	return 5
}

func sortByPriority(exercises []Exercise, priority []int) []Exercise {
	rank := make(map[int]int, len(priority))
	for i, id := range priority {
		rank[id] = i
	}
	less := func(a, b Exercise) bool {
		if ra, rb := rank[a.ID], rank[b.ID]; ra != rb {
			return ra < rb
		}
		if ca, cb := categoryRank(a.Category), categoryRank(b.Category); ca != cb {
			return ca < cb
		}
		return a.ID < b.ID
	}
	out := make([]Exercise, len(exercises))
	copy(out, exercises)
	sort.SliceStable(out, func(i, j int) bool { return less(out[i], out[j]) })
	return out
}

// EnvBacked reports whether the exercise runs a remote environment the
// engine must build and keep alive (as opposed to offline analysis of
// attachments).
func EnvBacked(d *Detail) bool {
	if d == nil {
		return false
	}
	return d.IsNeedInit || d.EndpointType == "monopoly"
}

// Brief renders the goal origin: everything the agent needs to operate
// the platform autonomously, without ever containing the access key (the
// agent reads it from the DASCTF_ACCESSKEY environment variable).
func Brief(c *Client, ex Exercise, d *Detail) string {
	host := c.Host()
	desc := ex.Category + " " + strconv.Itoa(ex.ID) + " " + ex.Name
	var b strings.Builder
	fmt.Fprintf(&b, "DASCTF 平台题(平台自动导入,标题前缀 %s 即来源,本题 exerciseId=%d)。\n\n", TitlePrefix, ex.ID)
	if d != nil && strings.TrimSpace(d.Description) != "" {
		desc += "\n描述: " + d.Description
	} else {
		desc += "\n描述: (平台未提供题目描述)"
	}
	fmt.Fprintf(&b, "题目: %s\n", desc)
	if d != nil {
		fmt.Fprintf(&b, "难度: %s,分值: %s。平台已判解出: %v\n", d.Difficulty, d.Score, d.HasSolved)
	}
	fmt.Fprintf(&b, "\n工作目录纪律:固定在 attack/%d/ 下作业(不存在则 mkdir -p),所有下载物、笔记、脚本放里面,跨步骤续战靠它。\n", ex.ID)

	// Attachments: offline analysis starts from these files.
	if d != nil && d.Attachment != nil && len(d.Attachment.Files) > 0 {
		b.WriteString("\n附件(第一步就下载到 attack/ 目录):\n")
		for _, f := range d.Attachment.Files {
			fmt.Fprintf(&b, "  - %s: %s\n", f.Name, f.URL)
		}
	}

	// Environment facts.
	if d != nil && EnvBacked(d) {
		b.WriteString("\n靶机环境(引擎托管构建,你不用调 build 接口):连接信息随时查详情接口拿最新的;")
		b.WriteString("isNeedCheck=true 表示环境还在准备中(等 30 秒重查);endpoints[] 里 isProxy=true 时用 proxyIps + portMappings[].proxy 端口连,否则直接连 exposeIps:ports;")
		b.WriteString("expireTime 是毫秒时间戳,临近过期或连接被拒就重查详情(引擎会自动重建);users[] 是平台给的账号密码。环境入口公网可达,无需 VPN。\n")
	} else {
		b.WriteString("\n本题无靶机环境(endpointType=none),纯离线分析:下载附件在本地解题。\n")
	}

	fmt.Fprintf(&b, "\n平台 API(鉴权 header: `X-Agent-AccessKey: $DASCTF_ACCESSKEY`,host 在 $DASCTF_HOST,均已注入你的 shell 环境变量,严禁写入文件或提交记录):\n")
	fmt.Fprintf(&b, "  1. GET  %s/slab-match/api/v1/agent/ctf/exercise?exerciseId=%d  — 题目详情+靶机连接信息+hasSolved\n", host, ex.ID)
	fmt.Fprintf(&b, "  2. POST %s/slab-match/api/v1/agent/answer-panel/answer -H \"Content-Type: application/json\" -d '{\"exerciseId\":%d,\"flag\":\"...\"}'  — 提交 flag 判定(正确返回 isCorrect=true;错误返回业务错误码)\n", host, ex.ID)

	b.WriteString("\n约束:\n")
	b.WriteString("- 本平台无提示(hint)机制,无扣分提示可用,硬啃。\n")
	b.WriteString("- 每题恰 1 个 flag,flag 形如 DASCTF{ 开头;拿到候选立即提交,不要攒。\n")
	b.WriteString("- 宿主是 Windows:严禁 wsl.exe;Linux ELF/二进制一律宿主 python 栈静态分析(pyelftools、capstone、ROPgadget、unicorn),远程交互用宿主 python 的 pwntools remote(),不做本地动态调试。\n")
	b.WriteString("- 错误提交可能触发平台风控,提交前先确认 flag 形态完整(不要提交截断值/哈希中间值)。\n\n")
	b.WriteString("完成判据(自检):详情接口显示本题 hasSolved=true(你提交的 flag 被判正确)。把 flag 值与提交接口的响应作为 Finding 记录(evidence 附 API 原始响应),据此宣布完成。\n")
	return b.String()
}

// Objective names the platform-verifiable completion criterion.
func Objective(ex Exercise) string {
	return fmt.Sprintf("解出 DASCTF 题目 %d(%s/%s)的 flag 并经平台 answer 接口确认 hasSolved=true。",
		ex.ID, ex.Category, ex.Name)
}

// SyncReport is the human-readable outcome of a sync round.
type SyncReport struct {
	Completed  []string // goals completed locally by this sync (platform confirmed)
	Mismatched []string // goals completed locally but platform says NOT solved
	Missing    []string // local dasctf goals whose exercise vanished from the platform
	InProgress int
}

// Sync reconciles platform state into the graph: when the platform says
// an exercise is solved, the matching active goal gets a completion fact
// and is completed.
func Sync(ctx context.Context, st *store.Store, c *Client) (*SyncReport, error) {
	exercises, err := c.List(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[int]Exercise, len(exercises))
	for _, ex := range exercises {
		byID[ex.ID] = ex
	}
	goals, err := st.ListGoals(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(goals, func(i, j int) bool { return goals[i].ID < goals[j].ID })
	rep := &SyncReport{}
	for _, g := range goals {
		id, ok := CodeOfTitle(g.Title)
		if !ok {
			continue
		}
		ex, found := byID[id]
		if !found {
			rep.Missing = append(rep.Missing, g.ID+" "+strconv.Itoa(id))
			continue
		}
		switch g.Status {
		case fgs.GoalActive:
			if ex.HasSolved {
				if err := completeFromPlatform(ctx, st, g.ID, ex); err != nil {
					return rep, err
				}
				rep.Completed = append(rep.Completed, g.ID+" "+strconv.Itoa(id))
			} else {
				rep.InProgress++
			}
		case fgs.GoalCompleted:
			if !ex.HasSolved {
				rep.Mismatched = append(rep.Mismatched, g.ID+" "+strconv.Itoa(id))
			}
		}
	}
	return rep, nil
}

func completeFromPlatform(ctx context.Context, st *store.Store, goalID string, ex Exercise) error {
	content := fmt.Sprintf("平台确认通关:DASCTF 题目 %d(%s)flag 判定正确(hasSolved=true)。",
		ex.ID, ex.Category)
	fact, err := st.AddHumanFact(ctx, goalID, content, ActorSync)
	if err != nil {
		return fmt.Errorf("dasctf: add completion fact for %d: %w", ex.ID, err)
	}
	desc := "平台 hasSolved=true。"
	if err := st.CompleteGoal(ctx, goalID, []string{fact.ID}, desc, ActorSync); err != nil {
		return fmt.Errorf("dasctf: complete goal %s: %w", goalID, err)
	}
	return nil
}
