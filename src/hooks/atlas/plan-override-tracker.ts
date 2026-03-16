import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { appendAtlasPlanOverride, readBoulderState, readPlanExecutionSummary } from "../../features/boulder-state"

export function extractExplicitOverrideReason(prompt: string): string | undefined {
  const patterns = [
    /override reason:\s*(.+)/i,
    /reason for override:\s*(.+)/i,
    /override because\s+(.+)/i,
  ]

  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }

  return undefined
}

export function extractTaskIdFromPrompt(prompt: string): string | undefined {
  const sectionMatch = prompt.match(/##\s*1\.\s*TASK[\s\S]*?(?:\n([^\n]+))/i)
  const candidate = sectionMatch?.[1]?.trim() ?? prompt.split(/\r?\n/).find((line) => /\b[A-Za-z0-9-]+\.\s+/.test(line))?.trim()
  const idMatch = candidate?.match(/\b([A-Za-z0-9-]+)\.\s+/)
  return idMatch?.[1]
}

function ensureFile(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function resolveAtlasPlannedTaskContext(input: {
  directory: string
  sessionID?: string
  prompt?: string
}): null | {
  planName: string
  nextWaveId?: string
  nextTaskIds: string[]
  promptTaskId?: string
  explicitOverrideReason?: string
  plannedTask: {
    id: string
    title: string
    category?: string
    wave?: string
    section: "todo" | "final-wave"
  }
} {
  if (!input.sessionID) return null

  const boulderState = readBoulderState(input.directory)
  if (!boulderState) return null

  const summary = readPlanExecutionSummary(boulderState.active_plan)
  if (!summary || summary.nextTasks.length === 0) return null

  const prompt = input.prompt ?? ""
  const promptTaskId = extractTaskIdFromPrompt(prompt)
  const plannedTask = promptTaskId
    ? summary.nextTasks.find((task) => task.id === promptTaskId) ?? summary.nextTasks[0]
    : summary.nextTasks[0]

  return {
    planName: boulderState.plan_name,
    ...(summary.nextWaveId ? { nextWaveId: summary.nextWaveId } : {}),
    nextTaskIds: summary.nextTasks.map((task) => task.id),
    ...(promptTaskId ? { promptTaskId } : {}),
    ...(extractExplicitOverrideReason(prompt) ? { explicitOverrideReason: extractExplicitOverrideReason(prompt) } : {}),
    plannedTask,
  }
}

export function trackAtlasPlanOverride(input: {
  directory: string
  sessionID?: string
  category?: string
  subagentType?: string
  prompt?: string
  correctionInjected?: boolean
}): boolean {
  const prompt = input.prompt ?? ""
  const boulderState = readBoulderState(input.directory)
  if (!boulderState) return false

  const summary = readPlanExecutionSummary(boulderState.active_plan)
  if (!summary || summary.nextTasks.length === 0) return false

  const context = resolveAtlasPlannedTaskContext(input)
  if (!context) return false

  const { plannedTask, promptTaskId, nextWaveId } = context

  const plannedCategory = plannedTask.category
  const actualCategory = input.category ?? input.subagentType
  const actualWave = plannedTask.wave ?? nextWaveId
  const plannedWave = plannedTask.wave ?? nextWaveId

  const taskIdMismatch = Boolean(promptTaskId && !summary.nextTasks.some((task) => task.id === promptTaskId))
  const categoryMismatch = Boolean(plannedCategory && actualCategory && plannedCategory !== actualCategory)
  const directAgentMismatch = Boolean(!input.category && input.subagentType && plannedCategory)

  if (!taskIdMismatch && !categoryMismatch && !directAgentMismatch) {
    return false
  }

  const reason = context.explicitOverrideReason ?? "No explicit override reason provided"
  const decisionsPath = join(input.directory, ".sisyphus", "notepads", boulderState.plan_name, "decisions.md")
  ensureFile(decisionsPath)

  const lines = [
    `## Atlas Override ${new Date().toISOString()}`,
    `- Planned task: \`${plannedTask.id}. ${plannedTask.title}\``,
    `- Prompt task: ${promptTaskId ? `\`${promptTaskId}\`` : "`unknown`"}`,
    `- Planned category: ${plannedCategory ? `\`${plannedCategory}\`` : "`unspecified`"}`,
    `- Actual category: ${actualCategory ? `\`${actualCategory}\`` : "`unspecified`"}`,
    `- Planned wave: ${plannedWave ? `\`${plannedWave}\`` : "`unspecified`"}`,
    `- Actual wave: ${actualWave ? `\`${actualWave}\`` : "`unspecified`"}`,
    `- Reason: ${reason}`,
    `- Correction injected: ${input.correctionInjected ? "yes" : "no"}`,
    "",
  ]

  appendAtlasPlanOverride(input.directory, {
    created_at: new Date().toISOString(),
    planned_task_id: plannedTask.id,
    planned_task_title: plannedTask.title,
    ...(promptTaskId ? { prompt_task_id: promptTaskId } : {}),
    ...(plannedCategory ? { planned_category: plannedCategory } : {}),
    ...(actualCategory ? { actual_category: actualCategory } : {}),
    ...(plannedWave ? { planned_wave: plannedWave } : {}),
    ...(actualWave ? { actual_wave: actualWave } : {}),
    reason,
    ...(input.correctionInjected ? { correction_injected: true } : {}),
  })

  appendFileSync(decisionsPath, `${lines.join("\n")}\n`, "utf-8")
  return true
}
