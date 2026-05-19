#!/usr/bin/env python3
"""
render_local.py — chat-chart local engine.

Reads a Chart.js-shaped config from stdin and renders a PNG to --out.
Lives in the agent container so chart data never leaves AWS. Matplotlib
is preinstalled into the agentcore venv at image build time (see
Dockerfile).

Chart.js → matplotlib mapping is intentionally narrow — only the subset
chat-chart/run.js can produce:

    type:        bar | line | pie | scatter
    data.labels: [str, ...]          (bar / line / pie)
    data.datasets[0].data:
        bar/line/pie: [number, ...]
        scatter:      [{ "x": number, "y": number }, ...]
    options.plugins.title.text: optional title string

Extending this surface should match a parallel extension in run.js so the
two engines stay symmetric.
"""

from __future__ import annotations

import argparse
import json
import sys

# Matplotlib's default backend tries to open a display; force Agg so the
# script never hits the X11 dependency chain inside the container.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402  — must follow .use()


def render(config: dict, out_path: str) -> None:
    chart_type = config.get("type")
    data = config.get("data") or {}
    datasets = data.get("datasets") or []
    if not datasets:
        raise ValueError("config.data.datasets is empty")
    series = datasets[0].get("data") or []
    if not series:
        raise ValueError("config.data.datasets[0].data is empty")

    title = (
        config.get("options", {})
        .get("plugins", {})
        .get("title", {})
        .get("text")
    )

    fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=160)

    if chart_type == "bar":
        labels = data.get("labels") or [str(i) for i in range(len(series))]
        ax.bar(labels, series)
        if len(labels) > 6:
            plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    elif chart_type == "line":
        labels = data.get("labels") or list(range(len(series)))
        ax.plot(labels, series, marker="o")
        if len(labels) > 6:
            plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    elif chart_type == "pie":
        labels = data.get("labels") or [str(i) for i in range(len(series))]
        ax.pie(series, labels=labels, autopct="%1.0f%%")
        ax.set_aspect("equal")
    elif chart_type == "scatter":
        xs = [p["x"] for p in series]
        ys = [p["y"] for p in series]
        ax.scatter(xs, ys)
    else:
        raise ValueError(f"unsupported chart type: {chart_type!r}")

    if title:
        ax.set_title(title)
    ax.grid(True, linestyle="--", alpha=0.3) if chart_type != "pie" else None
    fig.tight_layout()
    fig.savefig(out_path, format="png", facecolor="white")
    plt.close(fig)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="path to write the PNG")
    args = parser.parse_args()

    raw = sys.stdin.read()
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"render_local: stdin is not valid JSON: {exc}", file=sys.stderr)
        return 2

    try:
        render(config, args.out)
    except Exception as exc:  # noqa: BLE001 — surface anything to stderr
        print(f"render_local: render failed: {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
