package fgs

// transition.go declares every legal state transition as data. The store
// layer consults these tables before mutating; tests assert that the table
// itself stays in sync with the engine's usage.
//
// Rules trace back to Cairn behavior:
//   - goal active→completed only via a Decide "complete" verdict
//     (cairn server/routers/projects.py:complete_project)
//   - goal active→stopped / completed→active mirror stop/reopen
//   - step claim requires pending and no current claim (intent claim 409s)
//   - step success is only writable by the claiming worker (conclude)
//   - retryable failure puts a step back to pending while attempts remain

// GoalTransitions lists legal GoalStatus changes.
var GoalTransitions = map[GoalStatus][]GoalStatus{
	GoalActive:    {GoalCompleted, GoalStopped},
	GoalCompleted: {GoalActive}, // reopen
	GoalStopped:   {GoalActive}, // resume
}

// StepTransitions lists legal StepStatus changes.
var StepTransitions = map[StepStatus][]StepStatus{
	StepPending: {StepRunning, StepCancel},                       // claim / goal stopped
	StepRunning: {StepDone, StepPending, StepFailed, StepCancel}, // success / retryable / permanent / cancel
	StepDone:    {},                                              // terminal
	StepFailed:  {StepPending},                                   // human retry allowed
	StepCancel:  {},                                              // terminal
}

// FindingTransitions lists legal FindingStatus changes.
var FindingTransitions = map[FindingStatus][]FindingStatus{
	FindingOpen:     {FindingPromoted, FindingDiscard}, // Decide review
	FindingPromoted: {},
	FindingDiscard:  {},
}

// CanTransitionGoal reports whether from→to is a legal Goal transition.
func CanTransitionGoal(from, to GoalStatus) bool {
	for _, next := range GoalTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// CanTransitionStep reports whether from→to is a legal Step transition.
func CanTransitionStep(from, to StepStatus) bool {
	for _, next := range StepTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// CanTransitionFinding reports whether from→to is a legal Finding transition.
func CanTransitionFinding(from, to FindingStatus) bool {
	for _, next := range FindingTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}
