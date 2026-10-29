import ts from 'typescript';

/**
 * Type and syntax facts shared by every rule. Library types are recognized by
 * the class that declares a characteristic member, so the checks work against
 * both the package sources and its published declaration files.
 */
export class ViewModelModel {
  public readonly checker: ts.TypeChecker;
  readonly #ids = new Map<ts.Symbol, number>();

  public constructor(
    public readonly program: ts.Program,
    public readonly file: ts.SourceFile,
  ) {
    this.checker = program.getTypeChecker();
  }

  public typeAt(node: ts.Node): ts.Type {
    return this.checker.getTypeAtLocation(node);
  }

  public isViewModel(type: ts.Type | undefined): boolean {
    return (
      type !== undefined && declares(nonNull(this.checker, type), 'viewModelBinding', 'ViewModel')
    );
  }
  public isBinding(type: ts.Type | undefined): boolean {
    return type !== undefined && declares(type, 'watchCachesByTag', 'ViewModelBinding');
  }
  public isRuntime(type: ts.Type | undefined): boolean {
    return type !== undefined && declares(type, 'createBinding', 'ViewModelRuntime');
  }
  public isSpec(type: ts.Type | undefined): boolean {
    return type !== undefined && declares(type, 'withKey', 'ViewModelSpec');
  }
  public isFamily(type: ts.Type | undefined): boolean {
    return type !== undefined && declares(type, 'runWithOverride', 'ViewModelSpecFamily');
  }

  /** The ViewModel class a `ViewModelSpec<T>` resolves. */
  public specTarget(type: ts.Type): ts.Symbol | undefined {
    if (!this.isSpec(type)) return undefined;
    if (!(type.flags & ts.TypeFlags.Object)) return undefined;
    if (!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return undefined;
    const target = this.checker.getTypeArguments(type as ts.TypeReference)[0];
    return target === undefined ? undefined : viewModelSymbol(this, target);
  }

  public viewModelSymbol(type: ts.Type): ts.Symbol | undefined {
    return viewModelSymbol(this, type);
  }

  /** The symbol an identifier, property access, or import alias refers to. */
  public symbolOf(node: ts.Node | undefined): ts.Symbol | undefined {
    if (node === undefined) return undefined;
    const target = unwrap(node);
    const name = ts.isPropertyAccessExpression(target) ? target.name : target;
    let symbol =
      ts.isShorthandPropertyAssignment(name.parent) && name.parent.name === name
        ? this.checker.getShorthandAssignmentValueSymbol(name.parent)
        : this.checker.getSymbolAtLocation(name);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  /** Stable per-analysis identity for grouping symbols in strings. */
  public idOf(symbol: ts.Symbol): number {
    let id = this.#ids.get(symbol);
    if (id === undefined) {
      id = this.#ids.size + 1;
      this.#ids.set(symbol, id);
    }
    return id;
  }

  public text(node: ts.Node): string {
    return node.getText(this.file);
  }

  /** A `viewModelSpec`, `new ViewModelSpec`, or `ViewModelSpec.argN` construction. */
  public specConstruction(node: ts.Node): SpecConstruction | undefined {
    if (ts.isNewExpression(node)) {
      return this.isSpec(this.typeAt(node))
        ? this.#plainSpec(node, node.arguments ?? [])
        : undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = unwrap(node.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      /^arg[234]?$/.test(callee.name.text) &&
      declares(this.typeAt(callee.expression), 'arg2', 'ViewModelSpec')
    ) {
      const suffix = callee.name.text.slice(3);
      return {
        node,
        family: true,
        arity: suffix === '' ? 1 : Number(suffix),
        explicitType: true,
        builder: node.arguments[1],
        options: node.arguments[2],
      };
    }
    if (calleeName(node) === 'viewModelSpec' && this.isSpec(this.typeAt(node))) {
      return this.#plainSpec(node, node.arguments);
    }
    return undefined;
  }

  /** The construction a spec variable or static field is initialized with. */
  public declaredSpec(symbol: ts.Symbol | undefined): SpecConstruction | undefined {
    const declaration = symbol?.valueDeclaration;
    if (declaration === undefined) return undefined;
    if (!ts.isVariableDeclaration(declaration) && !ts.isPropertyDeclaration(declaration)) {
      return undefined;
    }
    if (ts.isVariableDeclaration(declaration) && !isConstVariable(declaration)) return undefined;
    const initializer = declaration.initializer;
    return initializer === undefined ? undefined : this.specConstruction(unwrap(initializer));
  }

  /** A method call `receiver.name(...)` whose receiver has a matching type. */
  public methodCall(
    node: ts.Node,
    names: ReadonlySet<string>,
    receiver: (type: ts.Type) => boolean,
  ): ts.CallExpression | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || !names.has(callee.name.text)) return undefined;
    return receiver(this.typeAt(callee.expression)) ? node : undefined;
  }

  /** A framework hook call whose first argument is a spec. */
  public hookCall(node: ts.Node, names: ReadonlySet<string>): ts.CallExpression | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    const name = calleeName(node);
    const spec = node.arguments[0];
    if (name === undefined || !names.has(name) || spec === undefined) return undefined;
    return this.isSpec(this.typeAt(spec)) ? node : undefined;
  }

  #plainSpec(
    node: ts.CallExpression | ts.NewExpression,
    args: readonly ts.Expression[],
  ): SpecConstruction {
    const first = args[0];
    const explicitType =
      first !== undefined &&
      args.length >= 2 &&
      this.typeAt(first).getConstructSignatures().length > 0;
    return {
      node,
      family: false,
      arity: 0,
      explicitType,
      builder: explicitType ? args[1] : first,
      options: explicitType ? args[2] : args[1],
    };
  }
}

export interface SpecConstruction {
  readonly node: ts.CallExpression | ts.NewExpression;
  /** `ViewModelSpec.argN` returns a callable family instead of a spec. */
  readonly family: boolean;
  readonly arity: number;
  /** Only explicit-type specs share unkeyed identity within one Binding. */
  readonly explicitType: boolean;
  readonly builder: ts.Expression | undefined;
  readonly options: ts.Expression | undefined;
}

export type OptionLookup =
  | { readonly state: 'missing' }
  | { readonly state: 'unknown' }
  | {
      readonly state: 'present';
      readonly property: ts.ObjectLiteralElementLike;
      readonly value: ts.Node;
    };

/** One option of a spec construction; spreads and non-literal objects are unknown. */
export function option(options: ts.Expression | undefined, name: string): OptionLookup {
  if (options === undefined) return { state: 'missing' };
  const literal = unwrap(options);
  if (!ts.isObjectLiteralExpression(literal)) return { state: 'unknown' };
  let found: OptionLookup = { state: 'missing' };
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      found = { state: 'unknown' };
      continue;
    }
    if (propertyName(property.name) !== name) continue;
    if (ts.isPropertyAssignment(property)) {
      found = { state: 'present', property, value: property.initializer };
    } else if (ts.isShorthandPropertyAssignment(property)) {
      found = { state: 'present', property, value: property.name };
    } else if (ts.isMethodDeclaration(property)) {
      found = { state: 'present', property, value: property };
    } else {
      found = { state: 'unknown' };
    }
  }
  return found;
}

/** Whether a spec construction has no key, or only a literal null/undefined one. */
export function isUnkeyed(spec: SpecConstruction): boolean {
  const key = option(spec.options, 'key');
  if (key.state === 'missing') return true;
  if (key.state === 'unknown') return false;
  const result = literalResult(key.value);
  return result !== undefined && isNullish(result);
}

/** The expression a value or a single-return callback evaluates to. */
export function literalResult(node: ts.Node): ts.Expression | undefined {
  const value = ts.isExpression(node) ? unwrap(node) : node;
  if (
    ts.isArrowFunction(value) ||
    ts.isFunctionExpression(value) ||
    ts.isMethodDeclaration(value)
  ) {
    const body = value.body;
    if (body === undefined) return undefined;
    if (!ts.isBlock(body)) return literalResult(body);
    const statement = body.statements.length === 1 ? body.statements[0] : undefined;
    return statement !== undefined && ts.isReturnStatement(statement) && statement.expression
      ? literalResult(statement.expression)
      : undefined;
  }
  return ts.isExpression(value) ? value : undefined;
}

export function isNullish(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined') ||
    ts.isVoidExpression(node)
  );
}

/** Remove parentheses and type-only wrappers. */
export function unwrap<T extends ts.Node>(node: T): ts.Node {
  let current: ts.Node = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The outermost parenthesized or type-only wrapper around an expression. */
export function outer(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

export function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

export function propertyName(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
  );
}

/** A `const`/`let`/`var` declared directly in a module or namespace body. */
export function isModuleLevel(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return (
    ts.isVariableStatement(statement) &&
    (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent))
  );
}

export function isConstVariable(declaration: ts.VariableDeclaration): boolean {
  return (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

/** The nearest function-like node that runs `node`; class bodies end the search. */
export function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
    if (ts.isClassLike(current) || ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

export function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassLike(current)) return current;
  }
  return undefined;
}

/** `this.viewModelBinding`, a ViewModel's own dependency Binding. */
export function isOwnBinding(node: ts.Node): boolean {
  const target = unwrap(node);
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'viewModelBinding' &&
    target.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** The name a function is declared under, looking through memo/forwardRef wrappers. */
export function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessor(fn)) return propertyName(fn.name);
  let child: ts.Node = outer(fn);
  let parent = child.parent;
  while (
    ts.isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === child) &&
    COMPONENT_WRAPPERS.has(calleeName(parent) ?? '')
  ) {
    child = outer(parent);
    parent = child.parent;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

const COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef', 'observer']);

export function isComponentName(name: string | undefined): boolean {
  return name !== undefined && /^[A-Z]/.test(name);
}

export function isHookName(name: string | undefined): boolean {
  return name !== undefined && /^use[A-Z0-9]/.test(name);
}

/** Whether the file renders through React, where hooks run on every render. */
export function usesReact(file: ts.SourceFile): boolean {
  return file.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return false;
    }
    const source = statement.moduleSpecifier.text;
    return (
      source === 'react' ||
      source === 'react-native' ||
      /(^|\/)view_model\/(react-native|electron)$/.test(source)
    );
  });
}

function declares(type: ts.Type, member: string, owner: string): boolean {
  const symbol = type.getProperty(member);
  return (
    symbol?.declarations?.some((declaration) => {
      const parent = declaration.parent;
      return (
        (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) && parent.name?.text === owner
      );
    }) ?? false
  );
}

function nonNull(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  return checker.getNonNullableType(type);
}

function viewModelSymbol(model: ViewModelModel, type: ts.Type): ts.Symbol | undefined {
  const target = nonNull(model.checker, type);
  return model.isViewModel(target) ? target.getSymbol() : undefined;
}
