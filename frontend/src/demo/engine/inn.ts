// Контрольные цифры ИНН юрлица (10 цифр) и ИП (12 цифр) — как backend/app/services/inn.py.
const checksum = (digits: number[], weights: number[]): number =>
    (weights.reduce((sum, w, i) => sum + w * digits[i], 0) % 11) % 10;

export function isValidInn(inn: string): boolean {
    if (!/^\d+$/.test(inn) || (inn.length !== 10 && inn.length !== 12)) return false;
    const d = [...inn].map(Number);
    if (inn.length === 10) return d[9] === checksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]);
    const n11 = checksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    const n12 = checksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    return d[10] === n11 && d[11] === n12;
}
