"""Run the planner on a throwaway folder, for the browser tests — your
scenarios, plans, board and unlocks are never touched.

    python -m tests.serve_temp 5071
"""
import shutil
import sys
import tempfile
from pathlib import Path

import server
import solver
import supply


def main(port: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="planner-test-"))
    (d / ".data").mkdir()
    server.SCENARIOS_DIR = solver.SCENARIOS_DIR = d
    server.RESULTS_DIR = d / ".results"
    server.HISTORY_DIR = d / ".history"
    server.BOARD_PATH = d / ".data" / "board.yaml"
    server.UNLOCKED_PATH = d / ".data" / "unlocked_alts.yaml"
    server.SAVE_NODES_PATH = d / ".data" / "save_nodes.json"
    server.MAP_SETTINGS_PATH = d / ".data" / "map_image.json"
    server.MAP_IMAGE_DIR = d / ".data"
    supply.PROGRESS_PATH = d / ".data" / "progress.yaml"
    supply.save_progress({"machines": ["Smelter", "Constructor", "Assembler", "Foundry", "Coal_Generator"]})
    try:
        server.run(port)
    finally:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 5071)
