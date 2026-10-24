/**
 * Condition evaluation for opencode-apex.
 * Dot-notation field matching used by the events module for subscription filters.
 */

/** Condition - evaluates to true/false based on context. */
export interface RuleCondition {
  /** Field path in context (e.g., "session.id", "tool.name") */
  field: string
  /** Operator: equals, contains, matches, gt, lt, in, notIn */
  operator: "equals" | "contains" | "matches" | "gt" | "lt" | "in" | "notIn" | "exists" | "notExists"
  /** Value to compare against */
  value?: unknown
  /** For regex matches */
  pattern?: string
}

/** Evaluate a single condition against a context object. */
export function evaluateCondition(condition: RuleCondition, context: Record<string, unknown>): boolean {
  // Get value from context using dot notation
  const getValue = (obj: Record<string, unknown>, path: string): unknown => {
    return path.split(".").reduce((acc: unknown, key: string) => {
      return (acc as Record<string, unknown>)?.[key]
    }, obj)
  }

  const contextValue = getValue(context, condition.field)

  switch (condition.operator) {
    case "exists":
      return contextValue !== undefined && contextValue !== null
    case "notExists":
      return contextValue === undefined || contextValue === null
    case "equals":
      return contextValue === condition.value
    case "contains":
      if (typeof contextValue === "string" && typeof condition.value === "string") {
        return contextValue.includes(condition.value)
      }
      if (Array.isArray(contextValue)) {
        return contextValue.includes(condition.value)
      }
      return false
    case "matches":
      if (typeof contextValue === "string" && condition.pattern) {
        return new RegExp(condition.pattern).test(contextValue)
      }
      return false
    case "gt":
      return (contextValue as number) > (condition.value as number)
    case "lt":
      return (contextValue as number) < (condition.value as number)
    case "in":
      if (Array.isArray(condition.value)) {
        return condition.value.includes(contextValue)
      }
      return false
    case "notIn":
      if (Array.isArray(condition.value)) {
        return !condition.value.includes(contextValue)
      }
      return true
    default:
      return false
  }
}
