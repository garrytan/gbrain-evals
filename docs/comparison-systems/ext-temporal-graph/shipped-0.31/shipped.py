"""Graphiti shim, SHIM_CONFIG=shipped-0.31: graphiti-core 0.31.2 built with its own defaults (protocol v1).

The adapter is the pinned bundle's shim.py, unchanged (copied into the image as graphiti_shim.py). Only the construction
differs: Graphiti(uri, user, password) with no llm_client, embedder or cross_encoder, so graphiti-core picks every model,
the reasoning effort, the verbosity, the prompt-cache mode and the extraction prompt itself. Its default clients are
AsyncOpenAI instances built with api_key=None and base_url=None, which read OPENAI_API_KEY and OPENAI_BASE_URL from the
environment; compose points OPENAI_BASE_URL at the metering proxy. At start the shim reads back the models the instance
resolved and refuses to serve unless they equal capability.json's model_roles, so the record and the run cannot drift.
"""
from __future__ import annotations

import os
from typing import Any

import graphiti_shim as base
from graphiti_core import Graphiti
from graphiti_core.cross_encoder import openai_reranker_client
from graphiti_core.llm_client import openai_base_client


def resolved_roles(graphiti: Graphiti) -> dict[str, Any]:
    llm, embedder, reranker = graphiti.llm_client, graphiti.embedder, graphiti.cross_encoder
    return {
        "extraction": llm.model or openai_base_client.DEFAULT_MODEL,
        "small": llm.small_model or openai_base_client.DEFAULT_SMALL_MODEL,
        "embedder": embedder.config.embedding_model,
        "dims": embedder.config.embedding_dim,
        "reranker": reranker.config.model or openai_reranker_client.DEFAULT_MODEL,
    }


class ShippedGraphitiAdapter(base.GraphitiAdapter):
    async def _connect(self) -> Graphiti:
        graphiti = Graphiti(os.environ.get("NEO4J_URI", "bolt://neo4j:7687"), os.environ.get("NEO4J_USER", "neo4j"),
                            os.environ["NEO4J_PASSWORD"])
        recorded, actual = self.record["configs"][base.CONFIG]["model_roles"], resolved_roles(graphiti)
        if actual != recorded:
            raise SystemExit(f"graphiti-core resolved model roles {actual}, capability.json records {recorded}")
        await graphiti.build_indices_and_constraints()
        return graphiti


if __name__ == "__main__":
    base.serve(ShippedGraphitiAdapter())
