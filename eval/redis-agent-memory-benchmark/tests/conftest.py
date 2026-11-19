# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/tests/conftest.py (Apache-2.0). Changes: none.
def pytest_addoption(parser):
    parser.addoption(
        "--run-api-tests",
        action="store_true",
        default=False,
        help="Run tests that use external provider APIs when present.",
    )
