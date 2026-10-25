package contract

import (
	"encoding/json"
	"strings"
	"testing"
)

func obj(t *testing.T, s string) map[string]any {
	t.Helper()
	v := tryDecodeObject(s)
	if v == nil {
		t.Fatalf("fixture is not JSON: %s", s)
	}
	return v
}

func TestExtractRaw(t *testing.T) {
	got, err := ExtractJSONObject(`{"accepted":true,"data":{}}`)
	if err != nil || got["accepted"] != true {
		t.Fatalf("raw: %v %v", got, err)
	}
}

func TestExtractFenced(t *testing.T) {
	text := "Here is my answer:\n```json\n{\"accepted\": true, \"data\": {\"complete\": {\"from\": [\"f_0001\"], \"description\": \"done\"}}}\n```\nHope that helps."
	got, err := ExtractJSONObject(text)
	if err != nil {
		t.Fatalf("fenced: %v", err)
	}
	if got["accepted"] != true {
		t.Fatalf("fenced content: %v", got)
	}
}

func TestExtractEmbeddedAfterProse(t *testing.T) {
	text := "Analysis complete. {\"accepted\": true, \"data\": {\"steps\": []}} trailing garbage"
	got, err := ExtractJSONObject(text)
	if err != nil {
		t.Fatalf("embedded: %v", err)
	}
	if _, ok := got["data"]; !ok {
		t.Fatalf("embedded content: %v", got)
	}
}

func TestExtractIgnoresNonObjects(t *testing.T) {
	if _, err := ExtractJSONObject(`just prose [1,2,3] "quoted"`); err != ErrNoObject {
		t.Fatalf("want ErrNoObject, got %v", err)
	}
}

func TestExtractPrefersFirstObject(t *testing.T) {
	got, err := ExtractJSONObject(`{"a":1} {"b":2}`)
	if err != nil || got["a"] != float64(1) {
		t.Fatalf("first object: %v %v", got, err)
	}
}

func TestValidateDecideComplete(t *testing.T) {
	p := obj(t, `{"accepted":true,"data":{"complete":{"from":["f_0001","f_0002"],"description":"goal met"}}}`)
	a, err := ValidateDecide(p, false, 2)
	if err != nil || a.Kind != KindComplete || a.Complete.From[1] != "f_0002" {
		t.Fatalf("complete: %+v %v", a, err)
	}
}

func TestValidateDecideSteps(t *testing.T) {
	raw := `{"accepted":true,"data":{"steps":[
		{"from":["f_0001"],"description":"probe API"},
		{"from":["f_0001","f_0002"],"description":"triangulate"},
		{"from":["f_0003"],"description":"extra"}
	]}}`
	a, err := ValidateDecide(obj(t, raw), false, 2)
	if err != nil {
		t.Fatalf("steps: %v", err)
	}
	if a.Kind != KindSteps || len(a.Steps) != 2 {
		t.Fatalf("truncation: %+v", a)
	}
	// empty steps with open steps → noop
	b, err := ValidateDecide(obj(t, `{"accepted":true,"data":{"steps":[]}}`), false, 2)
	if err != nil || b.Kind != KindNoop {
		t.Fatalf("empty steps noop: %+v %v", b, err)
	}
	// empty steps with no open steps → error (Cairn rule)
	if _, err := ValidateDecide(obj(t, `{"accepted":true,"data":{"steps":[]}}`), true, 2); err == nil {
		t.Fatal("empty steps with no open steps must fail")
	}
}

func TestValidateDecideFindingsReview(t *testing.T) {
	raw := `{"accepted":true,"data":{"findings":{"promote":["fd_0001"],"discard":["fd_0002","fd_0003"]},"steps":[{"from":["f_0001"],"description":"next"}]}}`
	a, err := ValidateDecide(obj(t, raw), false, 2)
	if err != nil {
		t.Fatalf("findings+steps: %v", err)
	}
	if len(a.Promote) != 1 || len(a.Discard) != 2 || a.Kind != KindSteps {
		t.Fatalf("review: %+v", a)
	}
	// duplicate id across promote/discard rejected
	dup := `{"accepted":true,"data":{"findings":{"promote":["fd_0001"],"discard":["fd_0001"]}}}`
	if _, err := ValidateDecide(obj(t, dup), false, 2); err == nil || !strings.Contains(err.Error(), "both") {
		t.Fatalf("dup: %v", err)
	}
}

func TestValidateDecideRejected(t *testing.T) {
	a, err := ValidateDecide(obj(t, `{"accepted":false,"reason":"unclear graph"}`), false, 2)
	if err != nil || a.Kind != KindRejected || a.RejectMsg != "unclear graph" {
		t.Fatalf("rejected: %+v %v", a, err)
	}
}

func TestValidateDecideMutuallyExclusive(t *testing.T) {
	raw := `{"accepted":true,"data":{"complete":{"from":["f_0001"],"description":"x"},"steps":[{"from":["f_0001"],"description":"y"}]}}`
	if _, err := ValidateDecide(obj(t, raw), false, 2); err == nil {
		t.Fatal("complete+steps must be rejected")
	}
}

func TestValidateDecideMissingFromFacts(t *testing.T) {
	if _, err := ValidateDecide(obj(t, `{"accepted":true,"data":{"complete":{"from":[],"description":"x"}}}`), false, 2); err == nil {
		t.Fatal("empty from must fail")
	}
	if _, err := ValidateDecide(obj(t, `{"accepted":true,"data":{"complete":{"description":"x"}}}`), false, 2); err == nil {
		t.Fatal("missing from must fail")
	}
}

func TestValidateExecute(t *testing.T) {
	a, err := ValidateExecute(obj(t, `{"accepted":true,"data":{"finding":{"content":"flag found at /admin","evidence":"session pi-1 output lines 3-5"}}}`))
	if err != nil || a.Content != "flag found at /admin" || a.Evidence == "" {
		t.Fatalf("execute: %+v %v", a, err)
	}
	b, err := ValidateExecute(obj(t, `{"accepted":true,"data":{"finding":{"content":"x"}}}`))
	if err != nil || b.Evidence != "" {
		t.Fatalf("evidence optional: %+v %v", b, err)
	}
	if _, err := ValidateExecute(obj(t, `{"accepted":true,"data":{}}`)); err == nil {
		t.Fatal("missing finding must fail")
	}
	if _, err := ValidateExecute(obj(t, `{"accepted":true,"data":{"finding":{"content":"  "}}}`)); err == nil {
		t.Fatal("blank content must fail")
	}
	if _, err := ValidateExecute(obj(t, `{"accepted":false,"reason":"cannot comply"}`)); err == nil {
		t.Fatal("rejected must fail")
	}
}

func TestUnwrapRawPayload(t *testing.T) {
	// Cairn tolerated unwrapped payloads via _unwrap_wrapped_payload.
	a, err := ValidateDecide(obj(t, `{"complete":{"from":["f_0001"],"description":"x"}}`), false, 2)
	if err != nil || a.Kind != KindComplete {
		t.Fatalf("raw payload: %+v %v", a, err)
	}
}

func TestRoundTripJSON(t *testing.T) {
	// guards against fixtures that aren't valid JSON at all
	if _, err := ExtractJSONObject("{not json"); err != ErrNoObject {
		t.Fatalf("invalid json: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(`{"ok":true}`), &v); err != nil || v["ok"] != true {
		t.Fatal("sanity")
	}
}
