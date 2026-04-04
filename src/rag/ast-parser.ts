/**
 * TypeScript AST Parser
 * Extracts structural relationships from .ts/.tsx files using the TS compiler API
 */

import ts from "typescript";

export interface AstImport {
  from: string;
  names: string[];
  isTypeOnly: boolean;
}

export interface AstExport {
  name: string;
  kind: "function" | "class" | "type" | "interface" | "enum" | "const" | "variable" | "default";
}

export interface AstSignature {
  name: string;
  doc?: string;
  line: number;
  text: string;
}

export interface AstParseResult {
  imports: AstImport[];
  exports: AstExport[];
  signatures: AstSignature[];
}

const EMPTY_RESULT: AstParseResult = { imports: [], exports: [], signatures: [] };

/**
 * Parse a TypeScript/TSX source file and extract structural relationships.
 * Returns empty arrays on parse failure (graceful degradation).
 */
export function parseAst(filePath: string, source: string): AstParseResult {
  try {
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true
    );

    const imports: AstImport[] = [];
    const exports: AstExport[] = [];
    const signatures: AstSignature[] = [];

    ts.forEachChild(sourceFile, (node) => {
      // --- Import declarations ---
      if (ts.isImportDeclaration(node)) {
        const from = (node.moduleSpecifier as ts.StringLiteral).text;
        const isTypeOnly = node.importClause?.isTypeOnly ?? false;
        const names: string[] = [];

        const clause = node.importClause;
        if (clause) {
          if (clause.name) {
            names.push("default");
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              names.push("*");
            } else if (ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                names.push(el.name.text);
              }
            }
          }
        }

        imports.push({ from, names, isTypeOnly });
      }

      // --- Export declarations ---
      else if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
        const name = node.name?.text ?? "default";
        const isDefault = hasDefaultModifier(node);
        exports.push({ name, kind: isDefault ? "default" : "function" });
        signatures.push({
          name,
          doc: extractJsDoc(node, sourceFile),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: extractSignatureText(node, source),
        });
      }

      else if (ts.isClassDeclaration(node) && hasExportModifier(node)) {
        const name = node.name?.text ?? "default";
        exports.push({ name, kind: "class" });
        signatures.push({
          name,
          doc: extractJsDoc(node, sourceFile),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: `class ${name}`,
        });
      }

      else if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: "type" });
      }

      else if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: "interface" });
      }

      else if (ts.isEnumDeclaration(node) && hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: "enum" });
      }

      else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
            exports.push({ name: decl.name.text, kind: isConst ? "const" : "variable" });

            // Capture arrow function signatures
            if (decl.initializer && ts.isArrowFunction(decl.initializer)) {
              signatures.push({
                name: decl.name.text,
                doc: extractJsDoc(node, sourceFile),
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                text: extractSignatureText(node, source),
              });
            }
          }
        }
      }

      // --- Re-exports: export { foo } from "./bar" ---
      else if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            exports.push({ name: el.name.text, kind: "variable" });
          }
        }
      }

      // --- export default ---
      else if (ts.isExportAssignment(node)) {
        exports.push({ name: "default", kind: "default" });
      }
    });

    return { imports, exports, signatures };
  } catch {
    return EMPTY_RESULT;
  }
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function extractJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const commentRanges = ts.getLeadingCommentRanges(fullText, nodeStart);
  if (!commentRanges?.length) return undefined;

  const last = commentRanges[commentRanges.length - 1];
  const comment = fullText.slice(last.pos, last.end);
  if (comment.startsWith("/**")) {
    // Strip /** ... */ and trim each line
    return comment
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
  }
  return undefined;
}

function extractSignatureText(node: ts.Node, source: string): string {
  // Get first line of the declaration
  const start = node.getStart();
  const end = source.indexOf("{", start);
  const sig = end > start ? source.slice(start, end).trim() : source.slice(start, start + 120).trim();
  // Truncate at newline if multi-line before brace
  const firstLine = sig.split("\n")[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
}
