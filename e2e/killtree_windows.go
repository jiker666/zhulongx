//go:build windows

package e2e

import (
	"fmt"
	"os/exec"
)

// killTree hard-kills a runner and its children. Windows keeps child
// processes alive when the parent dies; taskkill /T closes the whole tree.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/PID", fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run()
	cmd.Wait()
}

func setProcAttr(cmd *exec.Cmd) {}
