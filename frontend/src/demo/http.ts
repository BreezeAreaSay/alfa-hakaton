// Ответы имитации сервера в формате FastAPI: {"detail": "..."} для ошибок, список ошибок проверки для 422.

export class HttpError extends Error {
    constructor(
        public status: number,
        public detail: unknown,
    ) {
        super(typeof detail === 'string' ? detail : `HTTP ${status}`);
    }
}

export const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const noContent = (): Response => new Response(null, { status: 204 });

export const errorResponse = (error: HttpError): Response => json({ detail: error.detail }, error.status);

/** Тело запроса после разбора: объект JSON или поля формы. */
export type Body = Record<string, unknown>;

interface Issue {
    type: string;
    loc: (string | number)[];
    msg: string;
    input: unknown;
    ctx?: Record<string, unknown>;
}

/** Проверка тела запроса с сообщениями как у Pydantic: при ошибках — 422 со списком. */
export class Validator {
    private issues: Issue[] = [];

    constructor(
        private body: Body,
        private where: 'body' | 'query' | 'header' = 'body',
    ) {}

    private fail(field: string, type: string, msg: string, ctx?: Record<string, unknown>): undefined {
        this.issues.push({ type, loc: [this.where, field], msg, input: this.body[field], ...(ctx ? { ctx } : {}) });
        return undefined;
    }

    private present(field: string, required: boolean): boolean {
        const value = this.body[field];
        if (value === undefined) {
            if (required) this.fail(field, 'missing', 'Field required');
            return false;
        }
        return true;
    }

    number(
        field: string,
        opts: { required?: boolean; nullable?: boolean; gt?: number; ge?: number; le?: number; int?: boolean } = {},
    ): number | null | undefined {
        if (!this.present(field, opts.required ?? false)) return undefined;
        const raw = this.body[field];
        if (raw === null) {
            if (opts.nullable) return null;
            return opts.int
                ? this.fail(field, 'int_type', 'Input should be a valid integer')
                : this.fail(
                      field,
                      'decimal_type',
                      'Decimal input should be an integer, float, string or Decimal object',
                  );
        }
        const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(value)) {
            return opts.int
                ? this.fail(
                      field,
                      'int_parsing',
                      'Input should be a valid integer, unable to parse string as an integer',
                  )
                : this.fail(field, 'decimal_parsing', 'Input should be a valid decimal');
        }
        if (opts.int && !Number.isInteger(value)) {
            return this.fail(
                field,
                'int_from_float',
                'Input should be a valid integer, got a number with a fractional part',
            );
        }
        if (opts.gt !== undefined && !(value > opts.gt)) {
            return this.fail(field, 'greater_than', `Input should be greater than ${opts.gt}`, { gt: opts.gt });
        }
        if (opts.ge !== undefined && !(value >= opts.ge)) {
            return this.fail(field, 'greater_than_equal', `Input should be greater than or equal to ${opts.ge}`, {
                ge: opts.ge,
            });
        }
        if (opts.le !== undefined && !(value <= opts.le)) {
            return this.fail(field, 'less_than_equal', `Input should be less than or equal to ${opts.le}`, {
                le: opts.le,
            });
        }
        return value;
    }

    string(
        field: string,
        opts: { required?: boolean; nullable?: boolean; min?: number; max?: number } = {},
    ): string | null | undefined {
        if (!this.present(field, opts.required ?? false)) return undefined;
        const raw = this.body[field];
        if (raw === null && opts.nullable) return null;
        if (typeof raw !== 'string') return this.fail(field, 'string_type', 'Input should be a valid string');
        if (opts.min !== undefined && raw.length < opts.min) {
            const unit = opts.min === 1 ? 'character' : 'characters';
            return this.fail(field, 'string_too_short', `String should have at least ${opts.min} ${unit}`, {
                min_length: opts.min,
            });
        }
        if (opts.max !== undefined && raw.length > opts.max) {
            return this.fail(field, 'string_too_long', `String should have at most ${opts.max} characters`, {
                max_length: opts.max,
            });
        }
        return raw;
    }

    boolean(field: string, opts: { required?: boolean } = {}): boolean | undefined {
        if (!this.present(field, opts.required ?? false)) return undefined;
        const raw = this.body[field];
        if (typeof raw === 'boolean') return raw;
        if (raw === 'true' || raw === 1) return true;
        if (raw === 'false' || raw === 0) return false;
        return this.fail(field, 'bool_parsing', 'Input should be a valid boolean');
    }

    choice<T extends string>(
        field: string,
        options: readonly T[],
        opts: { required?: boolean; nullable?: boolean } = {},
    ): T | null | undefined {
        if (!this.present(field, opts.required ?? false)) return undefined;
        const raw = this.body[field];
        if (raw === null && opts.nullable) return null;
        if (typeof raw === 'string' && (options as readonly string[]).includes(raw)) return raw as T;
        const list = options.map((o) => `'${o}'`);
        const expected = list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0];
        return this.fail(field, 'enum', `Input should be ${expected}`, { expected });
    }

    stringList(field: string, opts: { required?: boolean; min?: number } = {}): string[] | undefined {
        if (!this.present(field, opts.required ?? false)) return undefined;
        const raw = this.body[field];
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
            return this.fail(field, 'list_type', 'Input should be a valid list');
        }
        if (opts.min !== undefined && raw.length < opts.min) {
            return this.fail(
                field,
                'too_short',
                `List should have at least ${opts.min} item after validation, not ${raw.length}`,
                { field_type: 'List', min_length: opts.min, actual_length: raw.length },
            );
        }
        return raw as string[];
    }

    object(field: string): Record<string, unknown> | null | undefined {
        if (!this.present(field, false)) return undefined;
        const raw = this.body[field];
        if (raw === null) return null;
        if (typeof raw !== 'object' || Array.isArray(raw))
            return this.fail(field, 'dict_type', 'Input should be a valid dictionary');
        return raw as Record<string, unknown>;
    }

    has(field: string): boolean {
        return this.body[field] !== undefined;
    }

    /** Бросает 422, если что-то не прошло проверку. */
    done(): void {
        if (this.issues.length) throw new HttpError(422, this.issues);
    }
}
