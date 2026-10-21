#!/usr/bin/env python3
"""Пересобирает таблицы сторонних пакетов в файле THIRD_PARTY_NOTICES.

Состав пакетов берётся из lock-файлов, лицензии и адреса проектов — из метаданных установленных пакетов.

- Python (backend, simulator): `uv.lock` и метаданные пакетов из `<проект>/.venv` — поля License-Expression,
  License, классификаторы `License ::`, Project-URL и Home-page. В поставку входят зависимости проекта без
  группы dev. Зависимости с маркерами отбираются для платформы образа: Linux x86_64 и версия CPython из
  строки `FROM python:…` в Dockerfile проекта.
- npm (frontend, e2e): `package-lock.json` и поле license из `node_modules/<пакет>/package.json`. В поставку
  входят записи без `"dev": true`. У платформенных сборок (поля os, cpu, libc) лицензия берётся из
  lock-файла: на машине установлена только сборка для текущей платформы.

Что нужно перед запуском:

- Python 3.11 или новее, только стандартная библиотека;
- `uv sync --frozen` в backend/ и simulator/ — вместе с группой dev, как по умолчанию;
- `npm ci` в frontend/ и e2e/;
- Linux, macOS или WSL: на Windows uv не устанавливает uvloop, и для него не найдутся метаданные.

Запуск из любого каталога:

    python3 scripts/third_party_notices.py           # обновить таблицы
    python3 scripts/third_party_notices.py --check   # только проверить, что таблицы актуальны (код 1, если нет)

Таблицы пишутся между строками `<!-- BEGIN GENERATED: имя -->` и `<!-- END GENERATED: имя -->`, остальной
текст файла не меняется. Строки отсортированы, в выводе нет дат, поэтому повторный запуск на тех же
lock-файлах даёт тот же файл. Если пакета из lock-файла нет в .venv или node_modules, файл не меняется,
а скрипт перечисляет, что нужно установить.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import re
import sys
import textwrap
import tomllib
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
NOTICES = ROOT / "THIRD_PARTY_NOTICES"

PYTHON_SHIPPED = ("backend", "simulator")
NPM_SHIPPED = "frontend"
NPM_TOOLS = ("frontend", "e2e")

NO_LICENSE = "не указана в метаданных"
NO_DATA = "нет данных"
COPYLEFT = re.compile(r"\b(?:A?GPL|LGPL|MPL|EPL|EUPL|CDDL|OSL|SSPL)\b|General Public|Mozilla Public", re.IGNORECASE)

# Части имён платформенных сборок npm: «lightningcss-linux-x64-gnu» → «lightningcss».
PLATFORM_TOKENS = {
    "aix", "android", "darwin", "freebsd", "linux", "netbsd", "openbsd", "openharmony", "sunos", "win32",
    "arm", "arm64", "ia32", "loong64", "mips64el", "ppc64", "ppc64le", "riscv64", "s390x", "x64", "wasm32",
    "eabi", "gnu", "gnueabihf", "msvc", "musl", "wasi", "universal",
}  # fmt: skip


@dataclass(frozen=True)
class Row:
    name: str
    version: str
    license: str
    url: str


class Problems:
    """Пакеты из lock-файлов, которых нет в .venv или node_modules, — по проектам и командам, которые это исправят."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], list[str]] = defaultdict(list)

    def add(self, project: str, command: str, package: str) -> None:
        if package not in self.items[(project, command)]:
            self.items[(project, command)].append(package)

    def __bool__(self) -> bool:
        return bool(self.items)

    def lines(self, shown: int = 5) -> list[str]:
        result = []
        for (project, command), packages in self.items.items():
            listed = ", ".join(packages[:shown])
            if len(packages) > shown:
                listed += f" и ещё {len(packages) - shown}"
            result.append(f"{project}: нет {listed} — выполните `{command}` в {project}/")
        return result


def plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def version_key(version: str) -> tuple:
    """Естественная сортировка версий: 2.10 после 2.9."""
    return tuple((0, int(part)) if part.isdigit() else (1, part) for part in re.split(r"[.+-]", version))


def sort_key(row: Row) -> tuple:
    return normalize(row.name), version_key(row.version)


# ------------------------------------------------------------------ маркеры PEP 508

MARKER_TOKEN = re.compile(
    r"\s*(?:(?P<str>'[^']*'|\"[^\"]*\")|(?P<op>===|==|!=|<=|>=|~=|<|>)|(?P<paren>[()])|(?P<word>[A-Za-z_][\w.]*))"
)
VERSION_VARIABLES = {"python_version", "python_full_version", "implementation_version"}


def release(version: str) -> tuple[int, ...]:
    match = re.match(r"\d+(?:\.\d+)*", version)
    if not match:
        raise ValueError(f"не версия: {version!r}")
    return tuple(int(part) for part in match.group(0).split("."))


def compare_versions(left: str, op: str, right: str) -> bool:
    if op in ("==", "!=") and right.endswith(".*"):
        prefix = release(right[:-2])
        equal = release(left)[: len(prefix)] == prefix
        return equal if op == "==" else not equal
    a, b = release(left), release(right)
    size = max(len(a), len(b))
    a, b = a + (0,) * (size - len(a)), b + (0,) * (size - len(b))
    if op == "~=":
        prefix = release(right)[:-1]
        return a >= b and release(left)[: len(prefix)] == prefix
    return {"==": a == b, "===": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


class Marker:
    """Вычисляет маркер окружения из uv.lock, например `sys_platform == 'win32' and python_full_version < '3.13'`."""

    def __init__(self, text: str, env: dict[str, str]) -> None:
        self.text, self.env, self.tokens, self.pos = text, env, [], 0
        position, text = 0, text.strip()
        while position < len(text):
            match = MARKER_TOKEN.match(text, position)
            if not match or match.end() == position:
                raise ValueError(f"Не удалось разобрать маркер: {self.text!r}")
            position = match.end()
            self.tokens.append((match.lastgroup, match.group(match.lastgroup)))

    def evaluate(self) -> bool:
        value = self.any_of()
        if self.pos != len(self.tokens):
            raise ValueError(f"Лишние символы в маркере: {self.text!r}")
        return value

    def peek(self) -> tuple[str | None, str | None]:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def take(self) -> tuple[str | None, str | None]:
        token = self.peek()
        self.pos += 1
        return token

    def any_of(self) -> bool:
        value = self.all_of()
        while self.peek() == ("word", "or"):
            self.take()
            right = self.all_of()
            value = value or right
        return value

    def all_of(self) -> bool:
        value = self.atom()
        while self.peek() == ("word", "and"):
            self.take()
            right = self.atom()
            value = value and right
        return value

    def atom(self) -> bool:
        if self.peek() == ("paren", "("):
            self.take()
            value = self.any_of()
            if self.take() != ("paren", ")"):
                raise ValueError(f"Нет закрывающей скобки в маркере: {self.text!r}")
            return value
        left, left_is_version = self.operand()
        op = self.operator()
        right, right_is_version = self.operand()
        if op in ("in", "not in"):
            return (left in right) == (op == "in")
        if left_is_version or right_is_version:
            return compare_versions(left, op, right)
        if op in ("==", "==="):
            return left == right
        if op == "!=":
            return left != right
        raise ValueError(f"Оператор {op} не применим к строкам: {self.text!r}")

    def operand(self) -> tuple[str, bool]:
        kind, value = self.take()
        if kind == "str":
            return value[1:-1], False
        if kind == "word" and value in self.env:
            return self.env[value], value in VERSION_VARIABLES
        raise ValueError(f"Неизвестная переменная {value!r} в маркере: {self.text!r}")

    def operator(self) -> str:
        kind, value = self.take()
        if kind == "op":
            return value
        if (kind, value) == ("word", "in"):
            return "in"
        if (kind, value) == ("word", "not") and self.take() == ("word", "in"):
            return "not in"
        raise ValueError(f"Нет оператора сравнения в маркере: {self.text!r}")


def image_environment(project_dir: Path) -> dict[str, str]:
    """Окружение маркеров для образа: Linux x86_64 и CPython из `FROM python:X.Y.Z…` в Dockerfile."""
    dockerfile = project_dir / "Dockerfile"
    match = re.search(r"^FROM\s+python:(\d+\.\d+\.\d+)", dockerfile.read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        raise SystemExit(f"{dockerfile.relative_to(ROOT)}: не найдена строка FROM python:X.Y.Z")
    full = match.group(1)
    return {
        "python_full_version": full,
        "python_version": ".".join(full.split(".")[:2]),
        "implementation_version": full,
        "implementation_name": "cpython",
        "platform_python_implementation": "CPython",
        "sys_platform": "linux",
        "platform_system": "Linux",
        "platform_machine": "x86_64",
        "platform_release": "",
        "platform_version": "",
        "os_name": "posix",
        "extra": "",
    }


# ------------------------------------------------------------------ Python: uv.lock и .venv


class UvLock:
    def __init__(self, project: str) -> None:
        self.project = project
        path = ROOT / project / "uv.lock"
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        self.by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.root: dict[str, Any] | None = None
        for package in data["package"]:
            self.by_name[package["name"]].append(package)
            source = package.get("source", {})
            if source.get("virtual") == "." or source.get("editable") == ".":
                self.root = package
        if self.root is None:
            raise SystemExit(f"{project}/uv.lock: не найден пакет самого проекта")

    def resolve(self, dependency: dict[str, Any]) -> dict[str, Any]:
        candidates = self.by_name.get(dependency["name"], [])
        if "version" in dependency:
            candidates = [p for p in candidates if p.get("version") == dependency["version"]]
        if len(candidates) != 1:
            raise SystemExit(f"{self.project}/uv.lock: не удалось однозначно найти зависимость {dependency}")
        return candidates[0]

    def walk(
        self, start: Iterable[dict[str, Any]], env: dict[str, str] | None
    ) -> tuple[dict[tuple[str, str], dict[str, Any]], dict[tuple[str, str], set[str]]]:
        """Пакеты, достижимые из start, и маркеры входящих связей. env=None — все связи без учёта маркеров."""
        seen: dict[tuple[str, str], dict[str, Any]] = {}
        seen_extras: set[tuple[tuple[str, str], str]] = set()
        markers: dict[tuple[str, str], set[str]] = defaultdict(set)
        stack = list(start)
        while stack:
            dependency = stack.pop()
            package = self.resolve(dependency)
            key = (package["name"], package["version"])
            marker = dependency.get("marker")
            if marker:
                markers[key].add(marker)
                if env is not None and not Marker(marker, env).evaluate():
                    continue
            if key not in seen:
                seen[key] = package
                stack.extend(package.get("dependencies", []))
            for extra in dependency.get("extra", []):
                if (key, extra) not in seen_extras:
                    seen_extras.add((key, extra))
                    stack.extend(package.get("optional-dependencies", {}).get(extra, []))
        return seen, markers


def site_packages(project: str) -> Path | None:
    venv = ROOT / project / ".venv"
    for candidate in [*sorted(venv.glob("lib/python*/site-packages")), venv / "Lib" / "site-packages"]:
        if candidate.is_dir():
            return candidate
    return None


def installed_distributions(project: str) -> dict[str, list[importlib.metadata.Distribution]]:
    found: dict[str, list[importlib.metadata.Distribution]] = defaultdict(list)
    path = site_packages(project)
    if path is not None:
        for distribution in importlib.metadata.distributions(path=[str(path)]):
            name = distribution.metadata["Name"]
            if name:
                found[normalize(name)].append(distribution)
    return found


def python_license(meta: Any) -> str:
    expression = (meta.get("License-Expression") or "").strip()
    if expression:
        return expression
    text = (meta.get("License") or "").strip()
    if text.upper() == "UNKNOWN":
        text = ""
    if text and "\n" not in text and len(text) <= 40:
        return text
    classifiers = [c.split(" :: ")[-1] for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    if classifiers:
        return ", ".join(classifiers) + " (по классификатору)"
    if text:
        first = text.splitlines()[0].strip()
        return first if len(first) <= 60 else first[:57].rstrip() + "…"
    return NO_LICENSE


def python_url(meta: Any, name: str) -> str:
    urls: dict[str, str] = {}
    for entry in meta.get_all("Project-URL") or []:
        label, _, url = entry.partition(",")
        urls.setdefault(re.sub(r"[\s_-]+", "", label).lower(), url.strip())
    for label in ("homepage", "home"):
        if urls.get(label):
            return urls[label]
    home_page = (meta.get("Home-page") or "").strip()
    if home_page and home_page.upper() != "UNKNOWN":
        return home_page
    for label in ("source", "sourcecode", "repository", "code", "github"):
        if urls.get(label):
            return urls[label]
    return f"https://pypi.org/project/{name}/"


@dataclass
class PythonProject:
    name: str
    python: str
    shipped: list[Row]
    dev_only: list[Row]
    other_platforms: list[tuple[str, str, list[str]]]


def python_project(project: str, problems: Problems) -> PythonProject:
    lock = UvLock(project)
    env = image_environment(ROOT / project)
    root = lock.root or {}
    runtime_start = root.get("dependencies", [])
    dev_start = [dep for group in root.get("dev-dependencies", {}).values() for dep in group]
    runtime, _ = lock.walk(runtime_start, env)
    dev, _ = lock.walk(dev_start, env)
    everything, markers = lock.walk([*runtime_start, *dev_start], None)
    distributions = installed_distributions(project)

    def row(package: dict[str, Any]) -> Row:
        name, version = package["name"], package["version"]
        candidates = distributions.get(normalize(name), [])
        matches = [d for d in candidates if d.version == version]
        if not matches:
            installed = ", ".join(sorted({d.version for d in candidates}))
            package = f"{name} {version}" + (f" (есть {installed})" if installed else "")
            problems.add(project, "uv sync --frozen", package)
            return Row(name, version, NO_DATA, f"https://pypi.org/project/{name}/")
        meta = matches[0].metadata
        return Row(meta["Name"], version, python_license(meta), python_url(meta, name))

    shipped = sorted((row(p) for p in runtime.values()), key=sort_key)
    dev_only = sorted((row(p) for key, p in dev.items() if key not in runtime), key=sort_key)
    other = [
        (name, version, sorted(markers.get((name, version), set())))
        for name, version in sorted(everything)
        if (name, version) not in runtime and (name, version) not in dev
    ]
    return PythonProject(project, env["python_full_version"], shipped, dev_only, other)


# ------------------------------------------------------------------ npm: package-lock.json и node_modules


@dataclass(frozen=True)
class NpmEntry:
    path: str
    name: str
    version: str
    data: dict[str, Any]

    @property
    def platform_specific(self) -> bool:
        return any(self.data.get(key) for key in ("os", "cpu", "libc"))


def npm_entries(project: str) -> Iterator[NpmEntry]:
    path = ROOT / project / "package-lock.json"
    lock = json.loads(path.read_text(encoding="utf-8"))
    if lock.get("lockfileVersion", 1) < 2:
        raise SystemExit(f"{project}/package-lock.json: нужен lockfileVersion 2 или 3 (npm 7+)")
    for key, data in lock["packages"].items():
        if not key or data.get("link"):
            continue
        name = data.get("name") or key.rsplit("node_modules/", 1)[-1]
        yield NpmEntry(key, name, data["version"], data)


def npm_license_value(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("type")
    if isinstance(value, list):
        value = " OR ".join(str(item.get("type") if isinstance(item, dict) else item) for item in value)
    return str(value).strip() if value else ""


def repository_url(url: str) -> str | None:
    url = url.strip().removeprefix("git+")
    for prefix, host in (
        ("github:", "https://github.com/"),
        ("gitlab:", "https://gitlab.com/"),
        ("bitbucket:", "https://bitbucket.org/"),
    ):
        if url.startswith(prefix):
            url = host + url[len(prefix) :]
    if re.fullmatch(r"[\w.-]+/[\w.-]+", url):
        url = "https://github.com/" + url
    url = re.sub(r"^git@([^:/]+):", r"https://\1/", url)
    url = re.sub(r"^(?:ssh://)?git@", "https://", url)
    url = re.sub(r"^git://", "https://", url)
    url = re.sub(r"\.git$", "", url)
    return url if url.startswith(("https://", "http://")) else None


def npm_url(package_json: dict[str, Any], name: str) -> str:
    homepage = package_json.get("homepage")
    if isinstance(homepage, str) and homepage.strip():
        return re.sub(r"#readme$", "", homepage.strip())
    repository = package_json.get("repository")
    url = repository.get("url") if isinstance(repository, dict) else repository
    if isinstance(url, str) and (normalized := repository_url(url)):
        return normalized
    return f"https://www.npmjs.com/package/{name}"


def npm_row(project: str, entry: NpmEntry, problems: Problems) -> Row:
    lock_license = npm_license_value(entry.data.get("license"))
    if entry.platform_specific:
        return Row(entry.name, entry.version, lock_license or NO_LICENSE, f"https://www.npmjs.com/package/{entry.name}")
    path = ROOT / project / entry.path / "package.json"
    if not path.is_file():
        problems.add(project, "npm ci", f"{entry.name} {entry.version}")
        return Row(entry.name, entry.version, NO_DATA, f"https://www.npmjs.com/package/{entry.name}")
    package_json = json.loads(path.read_text(encoding="utf-8"))
    if package_json.get("version") != entry.version:
        problems.add(project, "npm ci", f"{entry.name} {entry.version} (есть {package_json.get('version')})")
    value = npm_license_value(package_json.get("license")) or npm_license_value(package_json.get("licenses"))
    return Row(entry.name, entry.version, value or NO_LICENSE, npm_url(package_json, entry.name))


def platform_family(name: str) -> str:
    scope, _, base = name.rpartition("/")
    kept = [part for part in base.split("-") if part not in PLATFORM_TOKENS]
    return (scope + "/" if scope else "") + "-".join(kept or [base])


def npm_tool_rows(problems: Problems) -> list[tuple[Row, str]]:
    """Пакеты для сборки и проверки: devDependencies фронтенда и всё из e2e.

    Платформенные сборки одного пакета (lightningcss-linux-x64-gnu, lightningcss-darwin-arm64…) — одной строкой.
    """
    where: dict[Row, set[str]] = defaultdict(set)
    groups: dict[tuple[str, str, str], dict[str, NpmEntry]] = defaultdict(dict)
    group_projects: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    for project in NPM_TOOLS:
        for entry in npm_entries(project):
            if project == NPM_SHIPPED and not entry.data.get("dev"):
                continue
            if entry.platform_specific:
                license_ = npm_license_value(entry.data.get("license")) or NO_LICENSE
                key = (platform_family(entry.name), entry.version, license_)
                groups[key][entry.name] = entry
                group_projects[key].add(project)
            else:
                where[npm_row(project, entry, problems)].add(project)

    for key, members in groups.items():
        family, version, license_ = key
        names = sorted(members)
        if len(names) == 1:
            entry = members[names[0]]
            targets = " ".join("/".join(entry.data[k]) for k in ("os", "cpu", "libc") if entry.data.get(k))
            name = f"{entry.name} (только {targets})"
        else:
            label = plural(len(names), "платформенная сборка", "платформенные сборки", "платформенных сборок")
            name = f"{family}-* ({len(names)} {label})"
        where[Row(name, version, license_, f"https://www.npmjs.com/package/{names[0]}")] |= group_projects[key]

    rows = [(row, ", ".join(p for p in NPM_TOOLS if p in projects)) for row, projects in where.items()]
    return sorted(rows, key=lambda item: sort_key(item[0]))


def npm_shipped_rows(problems: Problems) -> list[Row]:
    rows = {npm_row(NPM_SHIPPED, e, problems) for e in npm_entries(NPM_SHIPPED) if not e.data.get("dev")}
    return sorted(rows, key=sort_key)


# ------------------------------------------------------------------ вывод


def table(headers: list[str], rows: Iterable[Iterable[str]]) -> list[str]:
    cells = [headers] + [[str(c).replace("|", "\\|").replace("\n", " ") for c in row] for row in rows]
    widths = [max(len(row[i]) for row in cells) for i in range(len(headers))]

    def line(row: list[str]) -> str:
        return "| " + " | ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)) + " |"

    return [line(cells[0]), "|" + "|".join("-" * (w + 2) for w in widths) + "|", *(line(r) for r in cells[1:])]


def package_table(rows: list[Row]) -> list[str]:
    return table(["Пакет", "Версия", "Лицензия", "Сайт проекта"], ([r.name, r.version, r.license, r.url] for r in rows))


def counted(n: int) -> str:
    return f"{n} {plural(n, 'пакет', 'пакета', 'пакетов')}"


def paragraph(text: str) -> list[str]:
    """Абзац с переносом строк по ширине остального текста файла."""
    return textwrap.wrap(text, width=115, break_long_words=False, break_on_hyphens=False)


def summary_block(components: dict[str, list[Row]], platforms: dict[str, str]) -> list[str]:
    total = sum(len(rows) for rows in components.values())
    pythons = ", ".join(f"{version} ({project})" for project, version in platforms.items())
    if len(set(platforms.values())) == 1:
        pythons = next(iter(platforms.values()))
    parts = ", ".join(f"{name} — {len(rows)}" for name, rows in components.items())
    lines = [
        *paragraph(
            f"Всего в поставке {counted(total)}: {parts} (пары «пакет — версия»). Зависимости Python отобраны "
            f"для образов: Linux x86_64, CPython {pythons} из Dockerfile."
        ),
        "",
    ]
    by_license: dict[str, Counter[str]] = defaultdict(Counter)
    for component, rows in components.items():
        for row in rows:
            by_license[row.license][component] += 1
    ordered = sorted(by_license.items(), key=lambda item: (-sum(item[1].values()), item[0].lower()))
    lines += table(
        ["Лицензия", *components, "Всего"],
        ([lic, *(str(c[name] or "—") for name in components), str(sum(c.values()))] for lic, c in ordered),
    )

    def mentions(predicate: Any, show_license: bool) -> str:
        found = [
            f"{row.name} {row.version}" + (f" — {row.license}" if show_license else "") + f" ({component})"
            for component, rows in components.items()
            for row in rows
            if predicate(row)
        ]
        return "; ".join(found) + "." if found else "нет."

    copyleft = mentions(lambda r: COPYLEFT.search(r.license), show_license=True)
    unlicensed = mentions(lambda r: r.license == NO_LICENSE, show_license=False)
    return [
        *lines,
        "",
        *paragraph(f"Лицензии с копилефтом (GPL, LGPL, AGPL, MPL и подобные): {copyleft}"),
        "",
        *paragraph(f"Лицензия не указана в метаданных: {unlicensed}"),
    ]


def tools_python_block(projects: list[PythonProject]) -> list[str]:
    where: dict[Row, list[str]] = defaultdict(list)
    for project in projects:
        for row in project.dev_only:
            where[row].append(project.name)
    rows = sorted(where, key=sort_key)
    lines = table(
        ["Пакет", "Версия", "Лицензия", "Где", "Сайт проекта"],
        ([r.name, r.version, r.license, ", ".join(where[r]), r.url] for r in rows),
    )
    other: dict[tuple[str, str], tuple[list[str], set[str]]] = {}
    for project in projects:
        for name, version, markers in project.other_platforms:
            entry = other.setdefault((name, version), ([], set()))
            entry[0].append(project.name)
            entry[1].update(markers)
    if other:
        described = [
            f"{name} {version} ({', '.join(projects_)}; маркер {', '.join(sorted(markers)) or 'не указан'})"
            for (name, version), (projects_, markers) in sorted(other.items())
        ]
        lines += [
            "",
            *paragraph(
                "В uv.lock есть и пакеты для других платформ, в образы для Linux они не устанавливаются: "
                + "; ".join(described)
                + "."
            ),
        ]
    return lines


def tools_npm_block(rows: list[tuple[Row, str]]) -> list[str]:
    return table(
        ["Пакет", "Версия", "Лицензия", "Где", "Сайт проекта"],
        ([r.name, r.version, r.license, where, r.url] for r, where in rows),
    )


def build_blocks(problems: Problems) -> dict[str, list[str]]:
    python = [python_project(project, problems) for project in PYTHON_SHIPPED]
    frontend = npm_shipped_rows(problems)
    shipped = {p.name: p.shipped for p in python} | {NPM_SHIPPED: frontend}
    return {
        "summary": summary_block(shipped, {p.name: p.python for p in python}),
        "backend": package_table(python[0].shipped),
        "simulator": package_table(python[1].shipped),
        "frontend": package_table(frontend),
        "tools-python": tools_python_block(python),
        "tools-npm": tools_npm_block(npm_tool_rows(problems)),
    }


BLOCK = re.compile(
    r"(?P<begin><!-- BEGIN GENERATED: (?P<name>[\w-]+) -->\n)(?P<body>.*?)(?P<end><!-- END GENERATED: (?P=name) -->)",
    re.DOTALL,
)


def render(text: str, blocks: dict[str, list[str]]) -> str:
    found: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        name = match.group("name")
        if name not in blocks:
            raise SystemExit(f"THIRD_PARTY_NOTICES: неизвестный блок {name!r}")
        found.add(name)
        return match.group("begin") + "\n" + "\n".join(blocks[name]) + "\n\n" + match.group("end")

    result = BLOCK.sub(replace, text)
    missing = sorted(set(blocks) - found)
    if missing:
        markers = ", ".join(f"<!-- BEGIN GENERATED: {name} -->" for name in missing)
        raise SystemExit(f"THIRD_PARTY_NOTICES: нет маркеров {markers} и парных END")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Обновляет таблицы пакетов в THIRD_PARTY_NOTICES.")
    parser.add_argument("--check", action="store_true", help="только проверить, что файл актуален")
    args = parser.parse_args()

    problems = Problems()
    blocks = build_blocks(problems)
    if problems:
        print("Не хватает установленных пакетов, THIRD_PARTY_NOTICES не изменён:", file=sys.stderr)
        for line in problems.lines():
            print(f"  - {line}", file=sys.stderr)
        return 2

    text = NOTICES.read_text(encoding="utf-8")
    result = render(text, blocks)
    if args.check:
        if result != text:
            print("THIRD_PARTY_NOTICES устарел: запустите python3 scripts/third_party_notices.py", file=sys.stderr)
            return 1
        print("THIRD_PARTY_NOTICES актуален")
        return 0
    if result != text:
        with NOTICES.open("w", encoding="utf-8", newline="\n") as file:
            file.write(result)
        print("THIRD_PARTY_NOTICES обновлён")
    else:
        print("THIRD_PARTY_NOTICES уже актуален")
    return 0


if __name__ == "__main__":
    sys.exit(main())
