import ts from 'typescript';

import {
  ViewModelModel,
  calleeName,
  enclosingClass,
  enclosingFunction,
  functionName,
  hasModifier,
  isComponentName,
  isHookName,
  isModuleLevel,
  isNullish,
  isOwnBinding,
  isUnkeyed,
  literalResult,
  option,
  outer,
  propertyName,
  unwrap,
  usesReact,
  type OptionLookup,
  type SpecConstruction,
} from './model.js';

export const RULE_KINDS = [
  'dependency-cycle',
  'cached-instance',
  'alive-forever-key',
  'unmanaged-construction',
  'listen-in-render',
  'instance-handoff',
  'identity-collision',
  'selector-with-watch',
  'undisposed-binding',
  'temporary-spec',
  'cached-lookup',
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

/** A text edit in source-file offsets. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface Finding {
  readonly kind: RuleKind;
  readonly node: ts.Node;
  readonly messageId: string;
  readonly data?: Record<string, string>;
  /** Edits a fix applies together, or undefined when nothing can be proved. */
  readonly fix?: readonly Edit[];
}

/** Create-or-get resolutions whose result is a single ViewModel. */
const BINDING_RETAINABLE = new Set([
  'read',
  'watch',
  'readCached',
  'watchCached',
  'maybeReadCached',
  'maybeWatchCached',
]);
const RUNTIME_RETAINABLE = new Set(['readCached', 'maybeReadCached']);
const BINDING_CACHED = new Set([
  'readCached',
  'watchCached',
  'maybeReadCached',
  'maybeWatchCached',
  'readCachesByTag',
  'watchCachesByTag',
]);
const RUNTIME_CACHED = new Set(['readCached', 'maybeReadCached', 'readCachesByTag']);
const RESOLVE = new Set(['read', 'watch']);
/** Own-binding calls that resolve and own a child generation. */
const OWN_RESOLUTIONS = new Set(['read', 'watch', 'listen', 'listenState', 'listenStateSelect']);
const BINDING_LISTENERS = new Set(['listen', 'listenState', 'listenStateSelect']);
const VIEW_MODEL_LISTENERS = new Set([
  'listen',
  'listenState',
  'listenStateSelect',
  'subscribe',
  'subscribeState',
  'addListener',
]);
const RESOLVE_HOOKS = new Set(['useViewModel', 'useReadViewModel']);
const SPEC_HOOKS = new Set(['useViewModel', 'useReadViewModel', 'useViewModelSelector']);
const SELECTOR_HOOKS = new Set(['useViewModelSelector']);
const WATCH_HOOKS = new Set(['useViewModel']);
const CREATE_BINDING = new Set(['createBinding']);
const OVERRIDE_METHODS = new Set(['overrideWith', 'setProxy', 'runWithOverride']);
const OVERRIDE_SCOPES = new Set(['runWithOverride', 'runWithOverrides']);
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);
const ACCESSIBILITY = new Set([
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
]);

interface ProgramCache {
  readonly files: WeakMap<ts.SourceFile, readonly Finding[]>;
  graph: DependencyGraph | undefined;
}

// Per-program state never survives an edit that produces a new program.
const caches = new WeakMap<ts.Program, ProgramCache>();

/** Every finding in one file, shared by all rules that lint it. */
export function analyze(program: ts.Program, file: ts.SourceFile): readonly Finding[] {
  let cache = caches.get(program);
  if (cache === undefined) {
    cache = { files: new WeakMap(), graph: undefined };
    caches.set(program, cache);
  }
  let findings = cache.files.get(file);
  if (findings === undefined) {
    const model = new ViewModelModel(program, file);
    cache.graph ??= new DependencyGraph(model);
    findings = file.isDeclarationFile ? [] : new Analyzer(model, cache.graph).run();
    cache.files.set(file, findings);
  }
  return findings;
}

interface ResolutionSite {
  readonly node: ts.CallExpression;
  readonly type: ts.Symbol;
  readonly signature: string;
  readonly varies: boolean;
}

interface HookSite {
  readonly node: ts.CallExpression;
  readonly spec: string;
  readonly selector: boolean;
}

class Analyzer {
  readonly #findings: Finding[] = [];
  readonly #file: ts.SourceFile;
  readonly #checker: ts.TypeChecker;
  readonly #react: boolean;
  readonly #resolutions = new Map<object, Map<ts.Symbol, ResolutionSite[]>>();
  readonly #hooks = new Map<ts.Node, HookSite[]>();

  public constructor(
    private readonly model: ViewModelModel,
    private readonly graph: DependencyGraph,
  ) {
    this.#file = model.file;
    this.#checker = model.checker;
    this.#react = usesReact(model.file);
  }

  public run(): readonly Finding[] {
    const visit = (node: ts.Node): void => {
      this.#visit(node);
      ts.forEachChild(node, visit);
    };
    visit(this.#file);
    this.#reportCollisions();
    this.#reportSelectorsWithWatch();
    return this.#findings;
  }

  #report(
    kind: RuleKind,
    node: ts.Node,
    messageId = 'default',
    data?: Record<string, string>,
    fix?: readonly Edit[],
  ): void {
    this.#findings.push({
      kind,
      node,
      messageId,
      ...(data === undefined ? {} : { data }),
      ...(fix === undefined ? {} : { fix }),
    });
  }

  #visit(node: ts.Node): void {
    const spec = this.model.specConstruction(node);
    if (spec !== undefined) {
      this.#checkAliveForeverKey(spec);
      this.#checkTemporarySpec(spec);
    }
    if (ts.isNewExpression(node)) this.#checkUnmanaged(node);
    if (ts.isCallExpression(node)) {
      this.#checkCachedInstance(node);
      this.#checkDependencyCycle(node);
      this.#checkListenInRender(node);
      this.#checkCachedLookup(node);
      this.#collectResolution(node);
      this.#collectHook(node);
      if (calleeName(node) === 'defineProps') this.#checkDefineProps(node);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) this.#checkUndisposed(node);
    if (ts.isConstructorDeclaration(node)) this.#checkConstructorHandoff(node);
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      this.#checkPropsHandoff(node);
    }
  }

  // view-model/alive-forever-key

  #checkAliveForeverKey(spec: SpecConstruction): void {
    const alive = option(spec.options, 'aliveForever');
    if (alive.state !== 'present') return;
    if (literalResult(alive.value)?.kind !== ts.SyntaxKind.TrueKeyword) return;
    const key = option(spec.options, 'key');
    if (key.state === 'unknown') return;
    if (key.state === 'present') {
      const result = literalResult(key.value);
      if (result === undefined || !isNullish(result)) return;
    }
    this.#report(
      'alive-forever-key',
      spec.node,
      'default',
      undefined,
      this.#keyFix(spec, alive, key),
    );
  }

  #keyFix(
    spec: SpecConstruction,
    alive: Extract<OptionLookup, { state: 'present' }>,
    key: OptionLookup,
  ): readonly Edit[] | undefined {
    // A single argument keeps the runtime's Map identity semantics; a
    // composite key for several arguments is an application decision.
    const value =
      spec.arity === 0 ? `'${this.#keyName(spec)}'` : spec.arity === 1 ? '(arg) => arg' : undefined;
    if (value === undefined) return undefined;
    if (key.state === 'present') {
      const property = key.property;
      if (ts.isPropertyAssignment(property)) {
        return [this.#replace(property.initializer, value)];
      }
      return [this.#replace(property, `key: ${value}`)];
    }
    const start = alive.property.getStart(this.#file);
    const indent = this.#textBeforeOnLine(start);
    // Keep one option per line when the object is laid out that way.
    const separator = indent.trim() === '' ? `,\n${indent}` : ', ';
    return [{ start, end: start, text: `key: ${value}${separator}` }];
  }

  #keyName(spec: SpecConstruction): string {
    const holder = outer(spec.node).parent;
    const variable =
      (ts.isVariableDeclaration(holder) || ts.isPropertyDeclaration(holder)) &&
      propertyName(holder.name);
    if (variable) {
      const stripped = variable.replace(/(Spec|Family)$/, '');
      return stripped === '' ? variable : stripped;
    }
    const type = this.#specTypeName(spec);
    return type === undefined ? 'viewModel' : lowerFirst(type);
  }

  #specTypeName(spec: SpecConstruction): string | undefined {
    if (spec.family) {
      const type = spec.node.arguments?.[0];
      return type === undefined ? undefined : this.model.text(unwrap(type));
    }
    return this.model.specTarget(this.model.typeAt(spec.node))?.getName();
  }

  // view-model/temporary-spec

  #checkTemporarySpec(spec: SpecConstruction): void {
    if (this.#isStableSpec(spec.node)) return;
    this.#report(
      'temporary-spec',
      spec.node,
      'default',
      undefined,
      this.#staticSpecFix(spec) ?? this.#extractSpecFix(spec),
    );
  }

  /**
   * Whether a spec is the single program-wide declaration of that spec: a
   * module-level variable or static field initializer. A generic function that
   * only returns the spec stands in for a generic variable, and a replacement
   * passed straight to an override API is reached only through the spec it overrides.
   */
  #isStableSpec(node: ts.Node): boolean {
    const child = outer(node);
    const parent = child.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
      return isModuleLevel(parent);
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === child) {
      return hasModifier(parent, ts.SyntaxKind.StaticKeyword);
    }
    if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === child)) {
      if (OVERRIDE_METHODS.has(calleeName(parent) ?? '')) return true;
    }
    if (ts.isArrayLiteralExpression(parent) && ts.isArrayLiteralExpression(parent.parent)) {
      const holder = outer(parent.parent).parent;
      if (ts.isCallExpression(holder) && calleeName(holder) === 'runWithOverrides') return true;
      if (ts.isPropertyAssignment(holder) && propertyName(holder.name) === 'overrides') return true;
    }
    const fn = enclosingFunction(child);
    if (fn === undefined || !fn.typeParameters?.length || !returnsOnly(fn, child)) return false;
    if (ts.isFunctionDeclaration(fn)) return isTopLevel(fn);
    if (ts.isMethodDeclaration(fn)) return hasModifier(fn, ts.SyntaxKind.StaticKeyword);
    const holder = outer(fn).parent;
    return ts.isVariableDeclaration(holder) && isModuleLevel(holder);
  }

  /** A private instance-field spec becomes static, and `this.x` becomes `Class.x`. */
  #staticSpecFix(spec: SpecConstruction): readonly Edit[] | undefined {
    const child = outer(spec.node);
    const field = child.parent;
    if (!ts.isPropertyDeclaration(field) || field.initializer !== child) return undefined;
    if (hasModifier(field, ts.SyntaxKind.StaticKeyword) || !isPlainField(field)) return undefined;
    const owner = field.parent;
    if (!ts.isClassLike(owner) || owner.name === undefined) return undefined;
    const isPrivate =
      ts.isPrivateIdentifier(field.name) || hasModifier(field, ts.SyntaxKind.PrivateKeyword);
    if (!isPrivate || this.#capturesInstance(spec.node, owner)) return undefined;
    const symbol = this.#checker.getSymbolAtLocation(field.name);
    if (symbol === undefined) return undefined;
    const anchor =
      (ts.getModifiers(field) ?? []).find((modifier) => !ACCESSIBILITY.has(modifier.kind)) ??
      field.name;
    const edits: Edit[] = [
      { start: anchor.getStart(this.#file), end: anchor.getStart(this.#file), text: 'static ' },
    ];
    const className = owner.name.text;
    let rewritable = true;
    this.#forEachReference(symbol, field.name, (reference) => {
      const access = reference.parent;
      if (
        ts.isPropertyAccessExpression(access) &&
        access.name === reference &&
        access.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        edits.push(this.#replace(access.expression, className));
      } else {
        rewritable = false;
      }
    });
    return rewritable ? edits : undefined;
  }

  /** A spec that captures nothing moves to a module-level const before its statement. */
  #extractSpecFix(spec: SpecConstruction): readonly Edit[] | undefined {
    const child = outer(spec.node);
    if (ts.isPropertyDeclaration(child.parent) && child.parent.initializer === child)
      return undefined;
    if (this.#capturesScope(spec.node)) return undefined;
    const statement = topStatement(spec.node);
    if (statement === undefined || !this.#dependenciesPrecede(spec.node, statement))
      return undefined;
    const name = this.#uniqueName(`${lowerFirst(this.#specTypeName(spec) ?? 'viewModel')}Spec`);
    const comments = ts.getLeadingCommentRanges(this.#file.text, statement.getFullStart());
    const anchor = comments?.[0]?.pos ?? statement.getStart(this.#file);
    const insertAt = this.#file.text.lastIndexOf('\n', anchor - 1) + 1;
    return [
      {
        start: insertAt,
        end: insertAt,
        text: `const ${name} = ${this.model.text(spec.node)};\n\n`,
      },
      this.#replace(spec.node, name),
    ];
  }

  #capturesInstance(node: ts.Node, owner: ts.ClassLikeDeclaration): boolean {
    const typeParameters = new Set(
      (owner.typeParameters ?? []).map((parameter) =>
        this.#checker.getSymbolAtLocation(parameter.name),
      ),
    );
    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) return;
      if (
        current.kind === ts.SyntaxKind.ThisKeyword ||
        current.kind === ts.SyntaxKind.SuperKeyword
      ) {
        found = true;
        return;
      }
      if (
        ts.isIdentifier(current) &&
        typeParameters.has(this.#checker.getSymbolAtLocation(current))
      ) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  }

  /** Whether `node` reads `this` or a local, parameter, or type parameter declared outside it. */
  #capturesScope(node: ts.Node): boolean {
    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) return;
      if (
        current.kind === ts.SyntaxKind.ThisKeyword ||
        current.kind === ts.SyntaxKind.SuperKeyword
      ) {
        found = true;
        return;
      }
      if (ts.isIdentifier(current) && isReference(current)) {
        if (current.text === 'arguments') {
          found = true;
          return;
        }
        const declaration = this.#checker.getSymbolAtLocation(current)?.declarations?.[0];
        if (
          declaration !== undefined &&
          !contains(node, declaration) &&
          declaration.getSourceFile() === this.#file &&
          isScopedDeclaration(declaration)
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  }

  /** Module-level declarations a moved spec reads must already be initialized. */
  #dependenciesPrecede(node: ts.Node, statement: ts.Statement): boolean {
    let precede = true;
    const visit = (current: ts.Node): void => {
      if (!precede) return;
      if (ts.isIdentifier(current) && isReference(current)) {
        const declaration = this.#checker.getSymbolAtLocation(current)?.declarations?.[0];
        if (declaration !== undefined && declaration.getSourceFile() === this.#file) {
          const top = topStatement(declaration);
          if (
            top !== undefined &&
            !ts.isFunctionDeclaration(top) &&
            !ts.isImportDeclaration(top) &&
            top.getStart(this.#file) >= statement.getStart(this.#file)
          ) {
            precede = false;
            return;
          }
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return precede;
  }

  #uniqueName(base: string): string {
    const taken = (name: string): boolean =>
      new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(this.#file.text);
    let name = base;
    for (let index = 2; taken(name); index += 1) name = `${base}${index}`;
    return name;
  }

  // view-model/unmanaged-construction

  #checkUnmanaged(node: ts.NewExpression): void {
    if (!this.model.isViewModel(this.model.typeAt(node))) return;
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const argument = outer(current);
        const call = argument.parent;
        if (
          (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
          call.arguments?.some((candidate) => candidate === argument) &&
          this.model.specConstruction(call) !== undefined
        ) {
          return;
        }
        continue;
      }
      if (ts.isFunctionLike(current) || ts.isClassLike(current)) break;
    }
    this.#report('unmanaged-construction', node);
  }

  // view-model/cached-instance

  #checkCachedInstance(node: ts.CallExpression): void {
    const retained =
      this.model.methodCall(node, BINDING_RETAINABLE, (type) => this.model.isBinding(type)) ??
      this.model.methodCall(node, RUNTIME_RETAINABLE, (type) => this.model.isRuntime(type)) ??
      this.model.hookCall(node, RESOLVE_HOOKS);
    if (retained === undefined || !this.model.isViewModel(this.model.typeAt(node))) return;
    const child = outer(node);
    const parent = child.parent;
    if (ts.isPropertyDeclaration(parent) && parent.initializer === child) {
      this.#report('cached-instance', node, 'default', undefined, this.#getterFix(parent));
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
      if (isModuleLevel(parent)) this.#report('cached-instance', node);
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.right === child &&
      ASSIGNMENTS.has(parent.operatorToken.kind) &&
      this.#isRetainingTarget(parent.left)
    ) {
      this.#report('cached-instance', node);
    }
  }

  #isRetainingTarget(target: ts.Expression): boolean {
    const left = unwrap(target);
    if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
      const name = ts.isPropertyAccessExpression(left) ? left.name : left.argumentExpression;
      const declarations = this.#checker.getSymbolAtLocation(name)?.declarations ?? [];
      // An explicit setter may transform its input instead of retaining it.
      return !declarations.some((declaration) => ts.isSetAccessor(declaration));
    }
    if (ts.isIdentifier(left)) {
      const declaration = this.model.symbolOf(left)?.valueDeclaration;
      return (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        isModuleLevel(declaration)
      );
    }
    return false;
  }

  /** `readonly x = binding.read(spec);` becomes `get x() { return binding.read(spec); }`. */
  #getterFix(field: ts.PropertyDeclaration): readonly Edit[] | undefined {
    const initializer = field.initializer;
    if (initializer === undefined || !isPlainField(field)) return undefined;
    if (!ts.isIdentifier(field.name) && !ts.isPrivateIdentifier(field.name)) return undefined;
    const modifiers = ts.getModifiers(field) ?? [];
    const readonly = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
    const isPrivate =
      ts.isPrivateIdentifier(field.name) ||
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword);
    // A getter cannot be assigned; only convert fields that are never reassigned.
    if (!readonly && !(isPrivate && !this.#isReassigned(field))) return undefined;
    const head = [
      ...modifiers
        .filter((modifier) => modifier.kind !== ts.SyntaxKind.ReadonlyKeyword)
        .map((modifier) => this.model.text(modifier)),
      'get',
    ].join(' ');
    const type = field.type === undefined ? '' : `: ${this.model.text(field.type)}`;
    const indent = this.#textBeforeOnLine(field.getStart(this.#file));
    const body = `{\n${indent}  return ${this.model.text(initializer)};\n${indent}}`;
    return [this.#replace(field, `${head} ${this.model.text(field.name)}()${type} ${body}`)];
  }

  #isReassigned(field: ts.PropertyDeclaration): boolean {
    const symbol = this.#checker.getSymbolAtLocation(field.name);
    let reassigned = false;
    if (symbol === undefined) return true;
    this.#forEachReference(symbol, field.name, (reference) => {
      const access = outer(reference.parent);
      const parent = access.parent;
      if (
        (ts.isBinaryExpression(parent) &&
          parent.left === access &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)
      ) {
        reassigned = true;
      }
    });
    return reassigned;
  }

  // view-model/dependency-cycle

  #checkDependencyCycle(node: ts.CallExpression): void {
    const target = this.graph.ownResolution(node);
    if (target === undefined) return;
    const owner = enclosingClass(node);
    const ownerSymbol =
      owner?.name === undefined ? undefined : this.#checker.getSymbolAtLocation(owner.name);
    if (ownerSymbol === undefined) return;
    if (!this.model.isViewModel(this.#checker.getDeclaredTypeOfSymbol(ownerSymbol))) return;
    const path = this.graph.path(target, ownerSymbol, new Set());
    if (path === undefined) return;
    this.#report('dependency-cycle', node, 'default', {
      path: [ownerSymbol, ...path].map((symbol) => symbol.getName()).join(' -> '),
    });
  }

  // view-model/listen-in-render

  #checkListenInRender(node: ts.CallExpression): void {
    const listen =
      this.model.methodCall(node, BINDING_LISTENERS, (type) => this.model.isBinding(type)) ??
      this.model.methodCall(node, VIEW_MODEL_LISTENERS, (type) => this.model.isViewModel(type));
    if (listen === undefined) return;
    const context = this.#repeatedContext(node);
    if (context !== undefined) this.#report('listen-in-render', node, 'default', { context });
  }

  /** The member that runs `node` on every render, getter access, or refresh request. */
  #repeatedContext(node: ts.Node): string | undefined {
    const fn = enclosingFunction(node);
    if (fn === undefined) return undefined;
    if (ts.isGetAccessor(fn)) return 'getter access';
    if (this.#isOnUpdate(fn)) return 'onUpdate refresh request';
    return this.#isRenderFunction(fn) ? 'render' : undefined;
  }

  /** A function component, React hook, or React class `render` method. */
  #isRenderFunction(fn: ts.SignatureDeclaration): boolean {
    if (ts.isMethodDeclaration(fn)) {
      if (propertyName(fn.name) !== 'render') return false;
      const owner = fn.parent;
      const symbol =
        ts.isClassLike(owner) && owner.name !== undefined
          ? this.#checker.getSymbolAtLocation(owner.name)
          : undefined;
      if (symbol === undefined) return false;
      // A React class component inherits setState and forceUpdate from Component.
      const type = this.#checker.getDeclaredTypeOfSymbol(symbol);
      return (
        type.getProperty('setState') !== undefined && type.getProperty('forceUpdate') !== undefined
      );
    }
    if (!ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) {
      return false;
    }
    const name = functionName(fn);
    // Vue composables run once per setup; only React hooks rerun on render.
    return isComponentName(name) || (this.#react && isHookName(name));
  }

  #isOnUpdate(fn: ts.SignatureDeclaration): boolean {
    const property = ts.isMethodDeclaration(fn) ? fn : outer(fn).parent;
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return false;
    if (propertyName(property.name) !== 'onUpdate') return false;
    const options = property.parent;
    if (!ts.isObjectLiteralExpression(options)) return false;
    const call = outer(options).parent;
    if (ts.isNewExpression(call)) return this.model.isBinding(this.model.typeAt(call));
    return (
      ts.isCallExpression(call) &&
      this.model.methodCall(call, CREATE_BINDING, (type) => this.model.isRuntime(type)) !==
        undefined
    );
  }

  // view-model/cached-lookup

  #checkCachedLookup(node: ts.CallExpression): void {
    const lookup =
      this.model.methodCall(node, BINDING_CACHED, (type) => this.model.isBinding(type)) ??
      this.model.methodCall(node, RUNTIME_CACHED, (type) => this.model.isRuntime(type));
    if (lookup !== undefined) this.#report('cached-lookup', node);
  }

  // view-model/instance-handoff

  #checkConstructorHandoff(node: ts.ConstructorDeclaration): void {
    if (node.body === undefined) return;
    for (const parameter of node.parameters) {
      if (this.model.isViewModel(this.model.typeAt(parameter))) {
        this.#report('instance-handoff', parameter, 'constructor');
      }
    }
  }

  #checkPropsHandoff(
    node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  ): void {
    if (node.body === undefined || !isComponentName(functionName(node))) return;
    const props = node.parameters[0];
    if (props === undefined) return;
    const type = this.#checker.getNonNullableType(this.model.typeAt(props));
    for (const property of this.#checker.getPropertiesOfType(type)) {
      if (!this.model.isViewModel(this.#checker.getTypeOfSymbolAtLocation(property, props)))
        continue;
      const element = ts.isObjectBindingPattern(props.name)
        ? props.name.elements.find(
            (candidate) =>
              propertyName(candidate.propertyName ?? candidate.name) === property.getName(),
          )
        : undefined;
      this.#report('instance-handoff', element ?? props, 'prop', { name: property.getName() });
    }
  }

  /** Vue `<script setup>` props declared through a `defineProps<T>()` type argument. */
  #checkDefineProps(node: ts.CallExpression): void {
    const argument = node.typeArguments?.[0];
    if (argument === undefined) return;
    const type = this.#checker.getTypeFromTypeNode(argument);
    for (const property of this.#checker.getPropertiesOfType(type)) {
      if (!this.model.isViewModel(this.#checker.getTypeOfSymbolAtLocation(property, node)))
        continue;
      const member = ts.isTypeLiteralNode(argument)
        ? argument.members.find((candidate) => propertyName(candidate.name) === property.getName())
        : undefined;
      this.#report('instance-handoff', member ?? argument, 'prop', { name: property.getName() });
    }
  }

  // view-model/undisposed-binding

  #checkUndisposed(node: ts.CallExpression | ts.NewExpression): void {
    let messageId: 'binding' | 'runtime' | undefined;
    if (ts.isNewExpression(node)) {
      const type = this.model.typeAt(node);
      messageId = this.model.isRuntime(type)
        ? 'runtime'
        : this.model.isBinding(type)
          ? 'binding'
          : undefined;
    } else if (this.model.methodCall(node, CREATE_BINDING, (type) => this.model.isRuntime(type))) {
      messageId = 'binding';
    }
    if (messageId !== undefined && this.#isUndisposed(node)) {
      this.#report('undisposed-binding', node, messageId);
    }
  }

  /** Whether a created owner reaches no dispose call and no other owner. */
  #isUndisposed(node: ts.CallExpression | ts.NewExpression): boolean {
    const created = outer(node);
    const parent = created.parent;
    // A temporary such as `runtime.createBinding().read(spec)` cannot be
    // disposed later; any other use hands the owner to a new holder.
    if (ts.isExpressionStatement(parent)) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === created) {
      return parent.name.text !== 'dispose';
    }
    let holder: ts.Symbol | undefined;
    if (ts.isVariableDeclaration(parent) && parent.initializer === created) {
      // A module-level owner lives as long as the realm, as an app-wide owner does.
      if (!ts.isIdentifier(parent.name) || isModuleLevel(parent)) return false;
      holder = this.#checker.getSymbolAtLocation(parent.name);
    } else if (ts.isPropertyDeclaration(parent) && parent.initializer === created) {
      if (hasModifier(parent, ts.SyntaxKind.StaticKeyword)) return false;
      holder = this.#checker.getSymbolAtLocation(parent.name);
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.right === created &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      enclosingFunction(parent) !== undefined
    ) {
      holder = this.#assignedHolder(parent.left);
    }
    if (holder === undefined) return false;
    const usage = this.#usage(holder);
    if (usage.disposed || usage.escaped) return false;
    // Runtime disposal disposes every Binding it created.
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && this.#isRuntimeDisposed(callee.expression)) {
        return false;
      }
    }
    return true;
  }

  #assignedHolder(target: ts.Expression): ts.Symbol | undefined {
    const left = unwrap(target);
    if (ts.isIdentifier(left)) return this.model.symbolOf(left);
    if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const symbol = this.#checker.getSymbolAtLocation(left.name);
      const declaration = symbol?.valueDeclaration;
      if (declaration !== undefined && hasModifier(declaration, ts.SyntaxKind.StaticKeyword)) {
        return undefined;
      }
      return symbol;
    }
    // A property of another object hands the owner to that object.
    return undefined;
  }

  #isRuntimeDisposed(receiver: ts.Expression): boolean {
    const symbol = this.model.symbolOf(receiver);
    const declaration = symbol?.valueDeclaration;
    if (symbol === undefined || declaration === undefined) return false;
    if (ts.isParameter(declaration)) {
      // Override scopes dispose the Runtime they supply after the callback.
      const fn = outer(declaration.parent);
      const call = fn.parent;
      return ts.isCallExpression(call) && OVERRIDE_SCOPES.has(calleeName(call) ?? '');
    }
    return this.#usage(symbol).disposed;
  }

  #usage(holder: ts.Symbol): { disposed: boolean; escaped: boolean } {
    const usage = { disposed: false, escaped: false };
    this.#forEachReference(holder, undefined, (reference) => {
      let expression: ts.Node = reference;
      if (ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference) {
        expression = reference.parent;
      }
      expression = outer(expression);
      const parent = expression.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
        // A call such as `binding.dispose()` or a tear-off passed to a cleanup hook.
        if (parent.name.text === 'dispose') usage.disposed = true;
        return;
      }
      if (
        ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.arguments?.some((argument) => argument === expression)) ||
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) && parent.body === expression) ||
        (ts.isVariableDeclaration(parent) && parent.initializer === expression) ||
        ts.isArrayLiteralExpression(parent) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === expression) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isJsxExpression(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isExportAssignment(parent) ||
        (ts.isBinaryExpression(parent) &&
          parent.right === expression &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      ) {
        usage.escaped = true;
      }
    });
    return usage;
  }

  // view-model/identity-collision

  #collectResolution(node: ts.CallExpression): void {
    const binding = this.model.methodCall(node, RESOLVE, (type) => this.model.isBinding(type));
    const hook = binding === undefined ? this.model.hookCall(node, SPEC_HOOKS) : undefined;
    if (binding === undefined && hook === undefined) return;
    const argument = node.arguments[0];
    if (argument === undefined) return;
    const scope =
      binding !== undefined
        ? this.#bindingScope((unwrap(node.expression) as ts.PropertyAccessExpression).expression)
        : enclosingFunction(node);
    if (scope === undefined) return;
    const spec = this.#unkeyedSpec(argument);
    const type = this.model.specTarget(this.model.typeAt(argument));
    if (spec === undefined || type === undefined) return;
    const byType = this.#resolutions.get(scope) ?? new Map<ts.Symbol, ResolutionSite[]>();
    this.#resolutions.set(scope, byType);
    const sites = byType.get(type) ?? [];
    byType.set(type, sites);
    sites.push({
      node,
      type,
      signature: spec.signature,
      varies: spec.arguments !== undefined && this.#varies(spec.arguments),
    });
  }

  /**
   * The Binding a resolution goes through: a ViewModel's own Binding, the
   * component that owns a hook Binding, or a variable/field holding a Binding.
   * Other receivers can hold different Bindings per object and are skipped.
   */
  #bindingScope(receiver: ts.Expression): object | undefined {
    if (isOwnBinding(receiver)) return enclosingClass(receiver);
    const target = unwrap(receiver);
    if (
      ts.isPropertyAccessExpression(target) &&
      target.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return this.#checker.getSymbolAtLocation(target.name);
    }
    if (!ts.isIdentifier(target)) return undefined;
    const symbol = this.model.symbolOf(target);
    const declaration = symbol?.valueDeclaration;
    if (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      const initializer = unwrap(declaration.initializer);
      if (ts.isCallExpression(initializer) && calleeName(initializer) === 'useViewModelBinding') {
        return enclosingFunction(declaration);
      }
    }
    return symbol;
  }

  /** An unkeyed explicit-type spec or argument family; unknown declarations are never guessed. */
  #unkeyedSpec(
    argument: ts.Expression,
  ): { signature: string; arguments: ts.NodeArray<ts.Expression> | undefined } | undefined {
    const expression = unwrap(argument);
    if (ts.isCallExpression(expression)) {
      const symbol = this.model.symbolOf(expression.expression);
      const family = this.model.declaredSpec(symbol);
      if (symbol === undefined || !family?.family || !isUnkeyed(family)) return undefined;
      const values = expression.arguments.map((value) => this.model.text(value)).join(', ');
      return {
        signature: `${this.model.idOf(symbol)}(${values})`,
        arguments: expression.arguments,
      };
    }
    const symbol = this.model.symbolOf(expression);
    const spec = this.model.declaredSpec(symbol);
    if (symbol === undefined || spec === undefined || spec.family) return undefined;
    // A builder-only spec has a private identity token and never collides.
    if (!spec.explicitType || !isUnkeyed(spec)) return undefined;
    return { signature: `${this.model.idOf(symbol)}`, arguments: undefined };
  }

  /**
   * Whether arguments read a variable that changes between calls on the same
   * owner: one declared in an enclosing loop or closure, or a parameter of a
   * method or function. Render parameters are fixed per owner, as Flutter's
   * `build` context is.
   */
  #varies(argumentsList: ts.NodeArray<ts.Expression>): boolean {
    const used = new Set<ts.Symbol>();
    for (const argument of argumentsList) this.#collectLocals(argument, used);
    if (used.size === 0) return false;
    for (let node = argumentsList[0]?.parent; node !== undefined; node = node.parent) {
      if (ts.isFunctionLike(node)) {
        if (this.#isRenderFunction(node)) return false;
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          if (intersects(used, this.#declaredIn(node))) return true;
          continue;
        }
        const parameters = new Set<ts.Symbol>();
        for (const parameter of node.parameters) this.#collectBindings(parameter.name, parameters);
        return intersects(used, parameters);
      }
      if (ts.isClassLike(node) || ts.isSourceFile(node)) return false;
      if (ts.isIterationStatement(node, false) && intersects(used, this.#declaredIn(node)))
        return true;
    }
    return false;
  }

  #collectLocals(node: ts.Node, into: Set<ts.Symbol>): void {
    if (ts.isIdentifier(node) && isReference(node)) {
      const symbol = this.#checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (symbol !== undefined && declaration !== undefined && isScopedDeclaration(declaration)) {
        into.add(symbol);
      }
    }
    ts.forEachChild(node, (child) => this.#collectLocals(child, into));
  }

  #declaredIn(node: ts.Node): Set<ts.Symbol> {
    const declared = new Set<ts.Symbol>();
    const visit = (current: ts.Node): void => {
      if (ts.isVariableDeclaration(current) || ts.isParameter(current)) {
        this.#collectBindings(current.name, declared);
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return declared;
  }

  #collectBindings(name: ts.BindingName, into: Set<ts.Symbol>): void {
    if (ts.isIdentifier(name)) {
      const symbol = this.#checker.getSymbolAtLocation(name);
      if (symbol !== undefined) into.add(symbol);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) this.#collectBindings(element.name, into);
    }
  }

  #reportCollisions(): void {
    for (const byType of this.#resolutions.values()) {
      for (const sites of byType.values()) {
        const first = sites[0]?.signature;
        for (const site of sites) {
          if (site.varies || site.signature !== first) {
            this.#report('identity-collision', site.node, 'default', { type: site.type.getName() });
          }
        }
      }
    }
  }

  // view-model/selector-with-watch

  #collectHook(node: ts.CallExpression): void {
    const selector = this.model.hookCall(node, SELECTOR_HOOKS) !== undefined;
    if (!selector && this.model.hookCall(node, WATCH_HOOKS) === undefined) return;
    const owner = enclosingFunction(node);
    const argument = node.arguments[0];
    if (owner === undefined || argument === undefined) return;
    const sites = this.#hooks.get(owner) ?? [];
    this.#hooks.set(owner, sites);
    sites.push({ node, spec: this.#specIdentity(argument), selector });
  }

  #specIdentity(argument: ts.Expression): string {
    const expression = unwrap(argument);
    if (ts.isCallExpression(expression)) {
      const symbol = this.model.symbolOf(expression.expression);
      const values = expression.arguments.map((value) => this.model.text(value)).join(', ');
      return symbol === undefined
        ? this.model.text(expression)
        : `${this.model.idOf(symbol)}(${values})`;
    }
    const symbol = this.model.symbolOf(expression);
    return symbol === undefined ? this.model.text(expression) : `${this.model.idOf(symbol)}`;
  }

  #reportSelectorsWithWatch(): void {
    for (const sites of this.#hooks.values()) {
      const selected = new Set(sites.filter((site) => site.selector).map((site) => site.spec));
      for (const site of sites) {
        if (!site.selector && selected.has(site.spec)) {
          this.#report(
            'selector-with-watch',
            site.node,
            'default',
            undefined,
            this.#useReadFix(site.node),
          );
        }
      }
    }
  }

  /** `useViewModel(spec)` becomes `useReadViewModel(spec)`, importing it when needed. */
  #useReadFix(node: ts.CallExpression): readonly Edit[] | undefined {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee))
      return [this.#replace(callee.name, 'useReadViewModel')];
    if (!ts.isIdentifier(callee)) return undefined;
    for (const statement of this.#file.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      if (!bindings.elements.some((element) => element.name.text === callee.text)) continue;
      const existing = bindings.elements.find(
        (element) => (element.propertyName ?? element.name).text === 'useReadViewModel',
      );
      if (existing !== undefined) return [this.#replace(callee, existing.name.text)];
      const last = bindings.elements[bindings.elements.length - 1]!;
      return [
        { start: last.end, end: last.end, text: ', useReadViewModel' },
        this.#replace(callee, 'useReadViewModel'),
      ];
    }
    return undefined;
  }

  // Shared helpers

  #replace(node: ts.Node, text: string): Edit {
    return { start: node.getStart(this.#file), end: node.end, text };
  }

  #textBeforeOnLine(position: number): string {
    const lineStart = this.#file.text.lastIndexOf('\n', position - 1) + 1;
    return this.#file.text.slice(lineStart, position);
  }

  /** Every identifier in this file that refers to `symbol`, except `declaration`. */
  #forEachReference(
    symbol: ts.Symbol,
    declaration: ts.Node | undefined,
    callback: (reference: ts.Identifier | ts.PrivateIdentifier) => void,
  ): void {
    const declarations = new Set<ts.Node>(
      (symbol.declarations ?? []).map(
        (candidate) => ts.getNameOfDeclaration(candidate) ?? candidate,
      ),
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        node !== declaration &&
        !declarations.has(node)
      ) {
        const reference =
          ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
            ? this.#checker.getShorthandAssignmentValueSymbol(node.parent)
            : this.#checker.getSymbolAtLocation(node);
        if (reference === symbol) callback(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(this.#file);
  }
}

/**
 * Static ViewModel type edges through each class's own `viewModelBinding`.
 * Bodies come from every source file in the program; declaration files have
 * no bodies and contribute no edges.
 */
class DependencyGraph {
  readonly #edges = new Map<ts.Symbol, Set<ts.Symbol>>();

  public constructor(private readonly model: ViewModelModel) {}

  /** The child type an own-binding `read/watch/listen*` call resolves. */
  public ownResolution(node: ts.Node): ts.Symbol | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || !OWN_RESOLUTIONS.has(callee.name.text)) {
      return undefined;
    }
    const spec = node.arguments[0];
    if (!isOwnBinding(callee.expression) || spec === undefined) return undefined;
    return this.model.specTarget(this.model.typeAt(spec));
  }

  public path(from: ts.Symbol, to: ts.Symbol, seen: Set<ts.Symbol>): ts.Symbol[] | undefined {
    if (from === to) return [from];
    if (seen.has(from)) return undefined;
    seen.add(from);
    for (const next of this.#children(from)) {
      const tail = this.path(next, to, seen);
      if (tail !== undefined) return [from, ...tail];
    }
    return undefined;
  }

  #children(symbol: ts.Symbol): Set<ts.Symbol> {
    const cached = this.#edges.get(symbol);
    if (cached !== undefined) return cached;
    const children = new Set<ts.Symbol>();
    this.#edges.set(symbol, children);
    for (const declaration of symbol.declarations ?? []) {
      if (!ts.isClassLike(declaration) || declaration.getSourceFile().isDeclarationFile) continue;
      const visit = (node: ts.Node): void => {
        if (node !== declaration && ts.isClassLike(node)) return;
        const child = this.ownResolution(node);
        if (child !== undefined) children.add(child);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(declaration, visit);
      // Inherited getters resolve through the same Binding as the subclass.
      for (const clause of declaration.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const base of clause.types) {
          const baseSymbol = this.model.viewModelSymbol(this.model.typeAt(base));
          if (baseSymbol === undefined || baseSymbol === symbol) continue;
          for (const inherited of this.#children(baseSymbol)) children.add(inherited);
        }
      }
    }
    return children;
  }
}

function returnsOnly(fn: ts.SignatureDeclaration, node: ts.Node): boolean {
  const body = (fn as { body?: ts.Node }).body;
  if (body === undefined) return false;
  if (!ts.isBlock(body)) return outer(body) === outer(node) || body === node;
  const statement = body.statements.length === 1 ? body.statements[0] : undefined;
  return (
    statement !== undefined &&
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined &&
    outer(unwrap(statement.expression)) === outer(node)
  );
}

function isTopLevel(node: ts.Node): boolean {
  return ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent);
}

function topStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) current = current.parent;
  return current.parent !== undefined && ts.isStatement(current) ? current : undefined;
}

/** A field without declare/abstract/accessor/decorators or definite assignment markers. */
function isPlainField(field: ts.PropertyDeclaration): boolean {
  if (field.questionToken !== undefined || field.exclamationToken !== undefined) return false;
  if ((ts.getDecorators(field)?.length ?? 0) > 0) return false;
  return !(
    hasModifier(field, ts.SyntaxKind.DeclareKeyword) ||
    hasModifier(field, ts.SyntaxKind.AbstractKeyword) ||
    hasModifier(field, ts.SyntaxKind.AccessorKeyword)
  );
}

/** A declaration that lives inside a function, block, or class rather than the module. */
function isScopedDeclaration(declaration: ts.Declaration): boolean {
  if (ts.isParameter(declaration) || ts.isTypeParameterDeclaration(declaration)) return true;
  if (ts.isBindingElement(declaration)) return true;
  if (ts.isVariableDeclaration(declaration)) return !isModuleLevel(declaration);
  if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    return !isTopLevel(declaration);
  }
  return false;
}

/** An identifier in an expression or type position, not a member or property name. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isJsxAttribute(parent)) return false;
  return !ts.isLabeledStatement(parent) && !ts.isBreakOrContinueStatement(parent);
}

function contains(outerNode: ts.Node, inner: ts.Node): boolean {
  return (
    inner.pos >= outerNode.pos &&
    inner.end <= outerNode.end &&
    inner.getSourceFile() === outerNode.getSourceFile()
  );
}

function intersects(left: ReadonlySet<ts.Symbol>, right: ReadonlySet<ts.Symbol>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
