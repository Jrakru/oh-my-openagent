/**
 * Boulder State Types
 *
 * Manages the active work plan state for Sisyphus orchestrator.
 * Named after Sisyphus's boulder - the eternal task that must be rolled.
 */

export interface AtlasPlanOverrideRecord {
  created_at: string
  planned_task_id: string
  planned_task_title: string
  prompt_task_id?: string
  planned_category?: string
  actual_category?: string
  planned_wave?: string
  actual_wave?: string
  reason: string
  correction_injected?: boolean
}

export interface BoulderState {
  /** Absolute path to the active plan file */
  active_plan: string
  /** ISO timestamp when work started */
  started_at: string
  /** Session IDs that have worked on this plan */
  session_ids: string[]
  /** Plan name derived from filename */
  plan_name: string
  /** Agent type to use when resuming (e.g., 'atlas') */
  agent?: string
  /** Absolute path to the git worktree root where work happens */
  worktree_path?: string
  /** Structured Atlas override records for this active plan */
  atlas_overrides?: AtlasPlanOverrideRecord[]
}

export interface PlanProgress {
  /** Total number of checkboxes */
  total: number
  /** Number of completed checkboxes */
  completed: number
  /** Whether all tasks are done */
  isComplete: boolean
}
