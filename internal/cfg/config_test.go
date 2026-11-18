package cfg

import (
	"strings"
	"testing"
	"time"
)

func TestEndgameWindowMustFitRunDeadline(t *testing.T) {
	base := Default()
	base.Runtime.RunDeadline = Duration(350 * time.Minute)
	base.Runtime.EndgameAfter = Duration(70 * time.Minute)
	if err := base.validate(); err != nil {
		t.Fatalf("valid harvest window rejected: %v", err)
	}

	for _, window := range []time.Duration{350 * time.Minute, 351 * time.Minute} {
		c := Default()
		c.Runtime.RunDeadline = Duration(350 * time.Minute)
		c.Runtime.EndgameAfter = Duration(window)
		err := c.validate()
		if err == nil || !strings.Contains(err.Error(), "endgame_after") {
			t.Fatalf("window %s should be rejected, got %v", window, err)
		}
	}
}
