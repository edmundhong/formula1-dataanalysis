import json
from types import SimpleNamespace
from unittest.mock import Mock

import pandas as pd
from pipeline.ingest import circuit_corners


def test_corner_serialization_filters_bad_rows():
    session = Mock()
    session.get_circuit_info.return_value = SimpleNamespace(corners=pd.DataFrame([
        {"Number": 2, "Letter": "A", "X": 10, "Y": 20, "Angle": 90},
        {"Number": 3, "Letter": None, "X": 30, "Y": 40, "Angle": float("nan")},
        {"Number": 4, "X": float("nan"), "Y": 40},
        {"Number": 4.5, "X": 30, "Y": 40},
    ]))
    corners = circuit_corners(session)
    assert corners == [
        {"number": 2, "letter": "A", "x": 10., "y": 20., "angle": 90.},
        {"number": 3, "letter": "", "x": 30., "y": 40., "angle": 0},
    ]
    json.dumps(corners, allow_nan=False)


def test_missing_corner_source_does_not_fail_analysis():
    session = Mock()
    session.get_circuit_info.return_value = None
    assert circuit_corners(session) == []
    session.get_circuit_info.side_effect = RuntimeError("source unavailable")
    assert circuit_corners(session) == []
    session.get_circuit_info.side_effect = None
    session.get_circuit_info.return_value = SimpleNamespace(corners=pd.DataFrame())
    assert circuit_corners(session) == []
