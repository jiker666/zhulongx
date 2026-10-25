//go:build !windows

package e2e

import (
	"os/exec"
	"syscall"
)

// killTree hard-kills a runner and its whole process group. startRunner
// launches runners with Setpgid, so the mockpi grandchildren die with it.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	cmd.Wait()
}

func setProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
