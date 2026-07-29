import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

describe("Nexus automatic memory onFinish wiring", () => {
  it("schedules only after assistant persistence and never awaits extraction", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/nexus/chat/route.ts"),
      "utf8",
    )
    const sourceFile = ts.createSourceFile(
      "route.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const callback = sourceFile.statements.find(
      (
        statement,
      ): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "createOnFinishCallback",
    )
    if (!callback?.body) {
      throw new TypeError("Expected createOnFinishCallback declaration")
    }

    let persisted: ts.BinaryExpression | undefined
    let scheduled: ts.CallExpression | undefined
    let cleanup: ts.CallExpression | undefined
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind ===
          ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === "assistantMessagePersisted" &&
        node.right.kind === ts.SyntaxKind.TrueKeyword
      ) {
        persisted = node
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text ===
          "scheduleNexusMemoryAutoExtraction"
      ) {
        scheduled = node
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "closeMcpClients"
      ) {
        cleanup = node
      }
      ts.forEachChild(node, visit)
    }
    visit(callback.body)

    if (!persisted || !scheduled || !cleanup) {
      throw new TypeError(
        "Expected persistence, extraction, and cleanup nodes",
      )
    }
    let ancestor: ts.Node | undefined = scheduled.parent
    let availabilityGuard: ts.IfStatement | undefined
    while (ancestor && ancestor !== callback.body) {
      if (ts.isIfStatement(ancestor)) {
        availabilityGuard = ancestor
        break
      }
      ancestor = ancestor.parent
    }

    expect(scheduled.getStart()).toBeGreaterThan(persisted.getStart())
    expect(cleanup.getStart()).toBeGreaterThan(scheduled.getStart())
    expect(availabilityGuard?.expression.getText(sourceFile)).toBe(
      "assistantMessagePersisted",
    )
    expect(ts.isAwaitExpression(scheduled.parent)).toBe(false)
    expect(ts.isAwaitExpression(cleanup.parent)).toBe(true)
  })
})
