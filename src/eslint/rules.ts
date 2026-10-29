import type { Rule } from 'eslint';
import ts from 'typescript';

import { analyze, type Edit, type RuleKind } from './analysis.js';

interface RuleDefinition {
  readonly type: 'problem' | 'suggestion';
  readonly description: string;
  readonly recommended: boolean;
  readonly fixable?: true;
  readonly hasSuggestions?: true;
  readonly messages: Readonly<Record<string, string>>;
}

const DOCS = 'https://github.com/lwj1994/js_view_model/blob/main/docs/lint.md';

export const RULE_DEFINITIONS: Readonly<Record<RuleKind, RuleDefinition>> = {
  'dependency-cycle': {
    type: 'problem',
    description: 'Report ViewModels that resolve each other through their own viewModelBinding.',
    recommended: true,
    messages: {
      default:
        'Potential ViewModel type dependency cycle: {{path}}. Review the dependency graph; keys and Bindings can distinguish instances, and runtime cycle validation still applies.',
    },
  },
  'cached-instance': {
    type: 'problem',
    description: 'Report a resolved ViewModel kept in a field or module-level variable.',
    recommended: true,
    fixable: true,
    messages: {
      default:
        'A stored resolved ViewModel can remain stale after recycle. Use a getter that resolves watch/read(spec) through the owner Binding on every access.',
    },
  },
  'alive-forever-key': {
    type: 'problem',
    description: 'Report aliveForever specs without an explicit key.',
    recommended: true,
    fixable: true,
    messages: {
      default:
        'aliveForever is true without an explicit key. Supply an explicit key for this spec.',
    },
  },
  'unmanaged-construction': {
    type: 'problem',
    description: 'Report a ViewModel constructed outside a spec builder.',
    recommended: true,
    messages: {
      default:
        'ViewModel constructed outside a spec builder. Construct it in a spec builder and resolve the spec through an owner Binding.',
    },
  },
  'listen-in-render': {
    type: 'problem',
    description: 'Report a listener registered on every render, getter access, or onUpdate.',
    recommended: true,
    messages: {
      default:
        'This listener is registered again on every {{context}}. Register it once, for example in onCreate or in an effect that returns its disposer.',
    },
  },
  'instance-handoff': {
    type: 'problem',
    description: 'Report a ViewModel passed through a constructor or component props.',
    recommended: true,
    messages: {
      constructor:
        "A ViewModel passed through a constructor bypasses Binding ownership. Pass a spec, key, or plain data and resolve the ViewModel through the receiver's Binding.",
      prop: "The ViewModel prop '{{name}}' bypasses Binding ownership. Pass a spec, key, or plain data and resolve the ViewModel in the receiving component.",
    },
  },
  'identity-collision': {
    type: 'problem',
    description: 'Report unkeyed resolutions in one Binding that share a single instance.',
    recommended: true,
    messages: {
      default:
        'Unkeyed {{type}} resolutions in one Binding share a single instance. Add a key that identifies each instance, for example one derived from the spec argument.',
    },
  },
  'selector-with-watch': {
    type: 'suggestion',
    description: 'Report useViewModel next to a selector for the same spec.',
    recommended: true,
    hasSuggestions: true,
    messages: {
      default:
        'useViewModel updates on every notification and defeats useViewModelSelector for the same spec. Resolve it with useReadViewModel and let the selector drive updates.',
      useRead: 'Resolve the ViewModel with useReadViewModel.',
    },
  },
  'undisposed-binding': {
    type: 'problem',
    description: 'Report a created ViewModelBinding or ViewModelRuntime that is never disposed.',
    recommended: true,
    messages: {
      binding:
        'This ViewModelBinding is never disposed, so its ViewModels stay bound. Call dispose() when the owner finishes, for example in afterEach or a finally block.',
      runtime:
        'This ViewModelRuntime is never disposed, so its ViewModels are never released. Call dispose() when its container finishes, for example in afterEach or a finally block.',
    },
  },
  'temporary-spec': {
    type: 'problem',
    description: 'Report a spec that is not a module-level or static variable.',
    recommended: true,
    fixable: true,
    messages: {
      default:
        'A spec must be a module-level or static variable, not a temporary value. Declare it once and reuse that variable.',
    },
  },
  'cached-lookup': {
    type: 'suggestion',
    description: 'Report cached queries that only find instances another owner created.',
    recommended: false,
    messages: {
      default:
        'A cached lookup only finds an instance that another owner created. Resolve a stable spec with watch/read unless this cross-owner query is intentional.',
    },
  },
};

interface EstreeNode {
  readonly range: [number, number];
}

/** The typescript-eslint services a type-aware rule reads. */
interface TypeAwareServices {
  readonly program: ts.Program;
  readonly esTreeNodeToTSNodeMap: { get(node: unknown): ts.Node | undefined };
  readonly tsNodeToESTreeNodeMap: { get(node: ts.Node): EstreeNode | undefined };
}

function typeAwareServices(context: Rule.RuleContext, kind: RuleKind): TypeAwareServices {
  const services = context.sourceCode.parserServices as Partial<TypeAwareServices> | undefined;
  if (
    services?.program == null ||
    services.esTreeNodeToTSNodeMap === undefined ||
    services.tsNodeToESTreeNodeMap === undefined
  ) {
    throw new Error(
      `view-model/${kind} requires type information. Lint this file with @typescript-eslint/parser and parserOptions.projectService (or parserOptions.project).`,
    );
  }
  return services as TypeAwareServices;
}

export function createRule(kind: RuleKind): Rule.RuleModule {
  const definition = RULE_DEFINITIONS[kind];
  return {
    meta: {
      type: definition.type,
      docs: {
        description: definition.description,
        recommended: definition.recommended,
        url: `${DOCS}#${kind}`,
      },
      ...(definition.fixable ? { fixable: 'code' as const } : {}),
      ...(definition.hasSuggestions ? { hasSuggestions: true } : {}),
      messages: { ...definition.messages },
      schema: [],
    },
    create(context) {
      return {
        Program(program) {
          const services = typeAwareServices(context, kind);
          const mapped = services.esTreeNodeToTSNodeMap.get(program);
          const file =
            mapped !== undefined && ts.isSourceFile(mapped)
              ? mapped
              : services.program.getSourceFile(context.filename);
          if (file === undefined) return;
          for (const finding of analyze(services.program, file)) {
            if (finding.kind !== kind) continue;
            const start = finding.node.getStart(file);
            const node = services.tsNodeToESTreeNodeMap.get(finding.node);
            // Hosts such as Vue SFCs embed the script; shift edits into the full text.
            const delta = node === undefined ? 0 : node.range[0] - start;
            const edits = finding.fix;
            const suggestion = finding.suggestion;
            const shift = (fixer: Rule.RuleFixer, list: readonly Edit[]) =>
              list.map((edit) =>
                fixer.replaceTextRange([edit.start + delta, edit.end + delta], edit.text),
              );
            const descriptor = {
              messageId: finding.messageId,
              ...(finding.data === undefined ? {} : { data: finding.data }),
              ...(edits === undefined
                ? {}
                : { fix: (fixer: Rule.RuleFixer) => shift(fixer, edits) }),
              ...(suggestion === undefined
                ? {}
                : {
                    suggest: [
                      {
                        messageId: suggestion.messageId,
                        fix: (fixer: Rule.RuleFixer) => shift(fixer, suggestion.edits),
                      },
                    ],
                  }),
            };
            if (node !== undefined) {
              context.report({ ...descriptor, node: node as unknown as Rule.Node });
            } else {
              const from = file.getLineAndCharacterOfPosition(start);
              const to = file.getLineAndCharacterOfPosition(finding.node.end);
              context.report({
                ...descriptor,
                loc: {
                  start: { line: from.line + 1, column: from.character },
                  end: { line: to.line + 1, column: to.character },
                },
              });
            }
          }
        },
      };
    },
  };
}
