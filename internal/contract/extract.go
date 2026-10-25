// Package contract extracts and validates agent output: JSON object
// extraction plus payload contracts for Decide/Execute answers.
//
// Two jobs:
//  1. ExtractJSONObject: pull the first JSON object out of arbitrary model
//     output (raw, markdown-fenced, or embedded after prose).
//  2. Validate*: turn that object into a typed verdict. A model saying
//     "success" is worth nothing until it passes here — this is the layer
//     that keeps agent claims from becoming graph truth.
package contract

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// ErrNoObject mirrors output_parser's "no JSON object found in output".
var ErrNoObject = fmt.Errorf("contract: no JSON object found in output")

var fencedBlockRe = regexp.MustCompile("(?is)```(?:json)?\\s*\\n?(.*?)```")

// ExtractJSONObject returns the first JSON object found in text.
//
// Candidate order (faithful to output_parser._candidate_segments):
//  1. the whole trimmed text
//  2. each markdown fenced block's content, in order
//
// For each candidate: try the whole string first, then decode from every
// '{' position (raw_decode semantics — trailing content is ignored).
// Non-object JSON values are skipped.
func ExtractJSONObject(text string) (map[string]any, error) {
	seen := map[string]bool{}
	candidates := []string{strings.TrimSpace(text)}
	for _, m := range fencedBlockRe.FindAllStringSubmatch(text, -1) {
		candidates = append(candidates, strings.TrimSpace(m[1]))
	}

	for _, segment := range candidates {
		if segment == "" || seen[segment] {
			continue
		}
		seen[segment] = true
		if obj := tryDecodeObject(segment); obj != nil {
			return obj, nil
		}
		for _, start := range objectStarts(segment) {
			if obj := tryDecodeObject(segment[start:]); obj != nil {
				return obj, nil
			}
		}
	}
	return nil, ErrNoObject
}

// tryDecodeObject decodes the first JSON value in s; returns it only when it
// is a JSON object (map).
func tryDecodeObject(s string) map[string]any {
	dec := json.NewDecoder(strings.NewReader(s))
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil
	}
	obj, _ := v.(map[string]any)
	return obj
}

func objectStarts(s string) []int {
	var out []int
	for i := 0; i < len(s); i++ {
		if s[i] == '{' {
			out = append(out, i)
		}
	}
	return out
}
