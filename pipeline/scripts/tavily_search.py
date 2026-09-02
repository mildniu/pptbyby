#!/usr/bin/env python3
"""Tavily Search Tool with Multi-Key Pool & Failover.

Provides search, Q&A synthesis, and image retrieval for topic-research and PPT sourcing.
Supports automatic key rotation across multiple configured API keys on rate limits or errors.

Usage:
    python3 scripts/tavily_search.py "中国电信 2026 算力网络 息壤"
    python3 scripts/tavily_search.py "低空经济发展现状" --depth advanced --max-results 5 --images
    python3 scripts/tavily_search.py "AI大模型" --save-to projects/my_project/sources/tavily_facts.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from console_encoding import configure_utf8_stdio
configure_utf8_stdio()


def _load_env_config() -> tuple[str, list[str]]:
    """Resolve Tavily base URL and API keys pool from env or .env file."""
    base_url = os.environ.get("TAVILY_BASE_URL", "https://api.tavily.com")
    raw_keys = os.environ.get("TAVILY_API_KEYS", "")

    if not raw_keys:
        candidates = [
            Path.cwd() / ".env",
            _SCRIPTS_DIR.parent / ".env",
            _SCRIPTS_DIR.parent.parent.parent / ".env",
            Path.home() / ".ppt-master" / ".env",
        ]
        for env_path in candidates:
            if env_path.is_file():
                try:
                    for line in env_path.read_text(encoding="utf-8").splitlines():
                        line = line.strip()
                        if line.startswith("#") or not line:
                            continue
                        if line.startswith("TAVILY_BASE_URL="):
                            base_url = line.split("=", 1)[1].strip().strip('"').strip("'")
                        elif line.startswith("TAVILY_API_KEYS="):
                            raw_keys = line.split("=", 1)[1].strip().strip('"').strip("'")
                except OSError:
                    pass
                if raw_keys:
                    break

    keys = [k.strip() for k in raw_keys.split(",") if k.strip()]
    return base_url.rstrip("/"), keys


class TavilySearchClient:
    """Tavily search client with automatic failover across multiple API keys."""

    def __init__(self, base_url: Optional[str] = None, keys: Optional[List[str]] = None):
        default_url, default_keys = _load_env_config()
        self.base_url = base_url or default_url
        self.keys = keys or default_keys
        self._current_key_idx = 0

        if not self.keys:
            # Fallback single key
            single_key = os.environ.get("TAVILY_API_KEY")
            if single_key:
                self.keys = [single_key.strip()]

    def search(
        self,
        query: str,
        search_depth: str = "advanced",
        max_results: int = 5,
        include_images: bool = False,
        include_answer: bool = True,
        days: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Execute Tavily search with multi-key failover."""
        if not self.keys:
            raise ValueError(
                "No Tavily API keys configured. Set TAVILY_API_KEYS in .env or environment."
            )

        payload: Dict[str, Any] = {
            "query": query,
            "search_depth": search_depth,
            "max_results": max_results,
            "include_images": include_images,
            "include_answer": include_answer,
        }
        if days:
            payload["days"] = days

        endpoint = f"{self.base_url}/search"
        last_error = None
        attempts = len(self.keys)

        for _ in range(attempts):
            api_key = self.keys[self._current_key_idx]
            payload["api_key"] = api_key

            try:
                resp = requests.post(endpoint, json=payload, timeout=30)
                if resp.status_code == 200:
                    data = resp.json()
                    data["_used_key_mask"] = api_key[:8] + "..." + api_key[-4:]
                    return data
                elif resp.status_code in (429, 401, 403):
                    # Rate limited or invalid key; rotate to next key
                    print(
                        f"[WARN] Key {api_key[:8]}... returned HTTP {resp.status_code}. Rotating to next key...",
                        file=sys.stderr,
                    )
                    self._current_key_idx = (self._current_key_idx + 1) % len(self.keys)
                    last_error = f"HTTP {resp.status_code}: {resp.text}"
                else:
                    resp.raise_for_status()
            except requests.RequestException as e:
                print(
                    f"[WARN] Request failed with key {api_key[:8]}... ({e}). Trying next...",
                    file=sys.stderr,
                )
                self._current_key_idx = (self._current_key_idx + 1) % len(self.keys)
                last_error = str(e)

        raise RuntimeError(f"All Tavily API keys failed. Last error: {last_error}")


def format_search_results_as_md(result: Dict[str, Any], query: str) -> str:
    """Format Tavily JSON result into research Markdown provenance."""
    lines = []
    lines.append(f"# Topic Research: {query}\n")

    if result.get("answer"):
        lines.append("## Executive Summary\n")
        lines.append(f"{result['answer']}\n")

    if result.get("results"):
        lines.append("## Key Sourced Findings\n")
        for idx, item in enumerate(result["results"], 1):
            title = item.get("title", "Untitled")
            url = item.get("url", "")
            content = item.get("content", "").strip()
            score = item.get("score", 0)
            lines.append(f"### {idx}. {title}\n")
            lines.append(f"- **Source**: {url}")
            lines.append(f"- **Relevance Score**: {score:.2f}")
            lines.append(f"- **Content**:\n  > {content}\n")

    if result.get("images"):
        lines.append("## Discovered Image Assets\n")
        for img_url in result["images"]:
            lines.append(f"- ![]({img_url})")
            lines.append(f"  *URL*: {img_url}\n")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Tavily Search Tool with Key Failover")
    parser.add_argument("query", help="Search query phrase")
    parser.add_argument(
        "--depth", choices=["basic", "advanced"], default="advanced", help="Search depth (basic/advanced)"
    )
    parser.add_argument("--max-results", type=int, default=5, help="Maximum search results count")
    parser.add_argument("--images", action="store_true", help="Include related images")
    parser.add_argument("--days", type=int, default=None, help="Limit results to past N days")
    parser.add_argument("--json", action="store_true", help="Output raw JSON format")
    parser.add_argument("--save-to", type=str, default=None, help="Save result Markdown to file path")

    args = parser.parse_args()

    client = TavilySearchClient()
    try:
        data = client.search(
            query=args.query,
            search_depth=args.depth,
            max_results=args.max_results,
            include_images=args.images,
            days=args.days,
        )
    except Exception as e:
        print(f"[ERROR] Tavily search failed: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        md_text = format_search_results_as_md(data, args.query)
        if args.save_to:
            out_path = Path(args.save_to)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(md_text, encoding="utf-8")
            print(f"[OK] Research findings saved to: {out_path}")
        else:
            print(md_text)


if __name__ == "__main__":
    main()
