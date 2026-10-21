def _checksum(digits: list[int], weights: list[int]) -> int:
    return sum(d * w for d, w in zip(digits, weights, strict=False)) % 11 % 10


def is_valid_inn(inn: str) -> bool:
    """Контрольные цифры ИНН юрлица (10 цифр) и ИП (12 цифр)."""
    if not inn.isdigit() or len(inn) not in (10, 12):
        return False
    d = [int(c) for c in inn]
    if len(inn) == 10:
        return d[9] == _checksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8])
    n11 = _checksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
    n12 = _checksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
    return d[10] == n11 and d[11] == n12
