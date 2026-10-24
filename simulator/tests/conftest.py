"""Окружение тестов: без задержек источников, созданные компании — во временном файле, а не в общем."""

import os
import tempfile
from pathlib import Path

os.environ.setdefault("SIMULATOR_LATENCY_SCALE", "0")
os.environ.setdefault("SIMULATOR_CUSTOM_FILE", str(Path(tempfile.mkdtemp()) / "custom_companies.json"))
