import { Clock, Terminal } from 'lucide-react'
import { type CtfTask } from '../../api'
import { CodeBlock, DataEmpty, GlassPanel, StatePill } from '../ui'

interface SandboxConsoleProps {
  task: CtfTask
}

export default function SandboxConsole({ task }: SandboxConsoleProps) {
  return (
    <div className="space-y-4">
      {task.current_script && <CodeBlock code={task.current_script} title="当前 solve.py" language="python" className="max-h-80 overflow-y-auto" />}

      <GlassPanel tone="cyan">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Sandbox Console</div>
            <h2 className="mt-1 text-lg font-semibold text-white">stdout / stderr</h2>
          </div>
          <StatePill tone="cyan" icon={<Terminal size={13} />}>{task.script_runs.length + task.shell_history.length} runs</StatePill>
        </div>

        {task.script_runs.length === 0 && task.shell_history.length === 0 ? (
          <DataEmpty title="尚无沙箱输出" description="脚本运行、命令执行、stdout/stderr 会显示在这里。" />
        ) : (
          <div className="space-y-3">
            {task.script_runs.slice(-5).reverse().map((run, index) => (
              <div key={`script-${index}`} className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3 text-xs">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatePill tone={run.success ? 'jade' : 'crimson'} className="min-h-6 px-2 py-0.5">script #{task.script_runs.length - index}</StatePill>
                  <span className="font-mono text-slate-400">exit={run.exit_code}</span>
                  <span className="inline-flex items-center gap-1 text-slate-500"><Clock size={11} /> {run.duration_ms}ms</span>
                  {run.timed_out && <StatePill tone="ember" className="min-h-6 px-2 py-0.5">timeout</StatePill>}
                </div>
                {run.stdout && <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-[11px] leading-5 text-slate-300">{run.stdout.slice(0, 1000)}{run.stdout.length > 1000 ? '\n...' : ''}</pre>}
                {run.stderr && <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-crimson-950/20 p-2 text-[11px] leading-5 text-crimson-200">{run.stderr.slice(0, 1000)}{run.stderr.length > 1000 ? '\n...' : ''}</pre>}
              </div>
            ))}
            {task.shell_history.slice(-4).reverse().map((shell, index) => (
              <div key={`shell-${index}`} className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3 text-xs">
                <div className="font-mono text-cyan-200">$ {shell.command}</div>
                <div className="mt-1 flex gap-2 text-[11px] text-slate-500">
                  <span>exit={shell.exit_code ?? '-'}</span>
                  <span>{shell.duration_ms}ms</span>
                </div>
                {shell.stdout && <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-[11px] text-slate-300">{shell.stdout.slice(0, 800)}{shell.stdout.length > 800 ? '\n...' : ''}</pre>}
                {shell.stderr && <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-crimson-950/20 p-2 text-[11px] text-crimson-200">{shell.stderr.slice(0, 800)}{shell.stderr.length > 800 ? '\n...' : ''}</pre>}
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  )
}
