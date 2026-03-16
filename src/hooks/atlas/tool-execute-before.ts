import { log } from "../../shared/logger"
import { SYSTEM_DIRECTIVE_PREFIX } from "../../shared/system-directive"
import { isCallerOrchestrator } from "../../shared/session-utils"
import type { PluginInput } from "@opencode-ai/plugin"
import { HOOK_NAME } from "./hook-name"
import { ORCHESTRATOR_DELEGATION_REQUIRED, SINGLE_TASK_DIRECTIVE } from "./system-reminder-templates"
import { resolveAtlasPlannedTaskContext, trackAtlasPlanOverride } from "./plan-override-tracker"
import { isSisyphusPath } from "./sisyphus-path"
import { isWriteOrEditToolName } from "./write-edit-tool-policy"

function buildStructuredExecutionDirective(input: {
  planName: string
  nextWaveId?: string
  plannedTask: {
    id: string
    title: string
    category?: string
    wave?: string
    section: "todo" | "final-wave"
  }
  explicitOverrideReason?: string
}): string {
  const tags: string[] = []
  if (input.plannedTask.category) tags.push(`category=\`${input.plannedTask.category}\``)
  if (input.plannedTask.wave ?? input.nextWaveId) tags.push(`wave=\`${input.plannedTask.wave ?? input.nextWaveId}\``)
  if (input.plannedTask.section === "final-wave") tags.push("final-wave")

  const overrideLine = input.explicitOverrideReason
    ? `Atlas declared an override reason: ${input.explicitOverrideReason}`
    : "Use this parsed next task as the default execution contract unless you have a concrete override reason."

  return `<system-reminder>
**STRUCTURED EXECUTION CONTRACT**

Plan: \`${input.planName}\`
Next task: \`${input.plannedTask.id}. ${input.plannedTask.title}\`${tags.length > 0 ? ` (${tags.join(", ")})` : ""}

${overrideLine}

If you override the planned task or category, state the reason explicitly in the delegation prompt.
</system-reminder>`
}

export function createToolExecuteBeforeHandler(input: {
  ctx: PluginInput
  pendingFilePaths: Map<string, string>
}): (
  toolInput: { tool: string; sessionID?: string; callID?: string },
  toolOutput: { args: Record<string, unknown>; message?: string }
) => Promise<void> {
  const { ctx, pendingFilePaths } = input

  return async (toolInput, toolOutput): Promise<void> => {
    if (!(await isCallerOrchestrator(toolInput.sessionID, ctx.client))) {
      return
    }

    // Check Write/Edit tools for orchestrator - inject strong warning
    // Warn-only policy: Atlas guides orchestrators toward delegation but doesn't block, allowing flexibility for urgent fixes
    if (isWriteOrEditToolName(toolInput.tool)) {
      const filePath = (toolOutput.args.filePath ?? toolOutput.args.path ?? toolOutput.args.file) as string | undefined
      if (filePath && !isSisyphusPath(filePath)) {
        // Store filePath for use in tool.execute.after
        if (toolInput.callID) {
          pendingFilePaths.set(toolInput.callID, filePath)
        }
        const warning = ORCHESTRATOR_DELEGATION_REQUIRED.replace("$FILE_PATH", filePath)
        toolOutput.message = (toolOutput.message || "") + warning
        log(`[${HOOK_NAME}] Injected delegation warning for direct file modification`, {
          sessionID: toolInput.sessionID,
          tool: toolInput.tool,
          filePath,
        })
      }
      return
    }

    // Check task - inject single-task directive
    if (toolInput.tool === "task") {
      const originalPrompt = toolOutput.args.prompt as string | undefined
      const plannedContext = resolveAtlasPlannedTaskContext({
        directory: ctx.directory,
        sessionID: toolInput.sessionID,
        prompt: originalPrompt,
      })

      const hasExplicitCategory = typeof toolOutput.args.category === "string"
      const hasExplicitSubagent = typeof toolOutput.args.subagent_type === "string"
      if (!hasExplicitCategory && !hasExplicitSubagent && plannedContext?.plannedTask.category) {
        toolOutput.args.category = plannedContext.plannedTask.category
        log(`[${HOOK_NAME}] Applied planned category from structured contract`, {
          sessionID: toolInput.sessionID,
          category: plannedContext.plannedTask.category,
          taskId: plannedContext.plannedTask.id,
        })
      }

      let prompt = originalPrompt
      const directives: string[] = []
      if (plannedContext && (!prompt || !prompt.includes("STRUCTURED EXECUTION CONTRACT"))) {
        directives.push(buildStructuredExecutionDirective(plannedContext))
      }
      if (prompt && !prompt.includes(SYSTEM_DIRECTIVE_PREFIX)) {
        directives.push(`<system-reminder>${SINGLE_TASK_DIRECTIVE}</system-reminder>`)
      }
      if (prompt && directives.length > 0) {
        toolOutput.args.prompt = `${directives.join("\n")}\n${prompt}`
        log(`[${HOOK_NAME}] Injected single-task directive to task`, {
          sessionID: toolInput.sessionID,
        })
      } else if (!prompt && directives.length > 0) {
        toolOutput.args.prompt = directives.join("\n")
      }

      const category = typeof toolOutput.args.category === "string" ? toolOutput.args.category : undefined
      const subagentType =
        typeof toolOutput.args.subagent_type === "string" ? toolOutput.args.subagent_type : undefined
      const tracked = trackAtlasPlanOverride({
        directory: ctx.directory,
        sessionID: toolInput.sessionID,
        category,
        subagentType,
        prompt,
      })
      if (tracked) {
        log(`[${HOOK_NAME}] Recorded Atlas plan override`, {
          sessionID: toolInput.sessionID,
          category,
          subagentType,
        })
      }
    }
  }
}
