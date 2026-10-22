// bcryptjs ships no typings — ambient declaration (global script file,
// intentionally NOT a module so it applies as a wildcard declaration).
declare module 'bcryptjs' {
    export function genSalt(rounds?: number): Promise<string>;
    export function hash(data: string, salt: string | number): Promise<string>;
    export function compare(data: string, encrypted: string): Promise<boolean>;
    const _default: {
        genSalt: typeof genSalt;
        hash: typeof hash;
        compare: typeof compare;
    };
    export default _default;
}
