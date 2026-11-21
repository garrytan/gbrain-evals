# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/prompts/judge.py (Apache-2.0). Changes: none.
"""Official LongMemEval judge prompts (Wu et al., ICLR 2025).

Source: github.com/xiaowu0162/LongMemEval  src/evaluation/evaluate_qa.py
Placeholders are substituted without str.format so braces in answers stay intact.
"""

DEFAULT = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response is equivalent to the correct answer or contains "
    "all the intermediate steps to get the correct answer, you should also answer "
    "yes. If the response only contains a subset of the information required by "
    "the answer, answer no. "
    "\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\n"
    "Model Response: {response}\n\n"
    "Is the model response correct? Answer yes or no only."
)
TEMPORAL = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response is equivalent to the correct answer or contains "
    "all the intermediate steps to get the correct answer, you should also answer "
    "yes. If the response only contains a subset of the information required by "
    "the answer, answer no. In addition, do not penalize off-by-one errors for "
    "the number of days. If the question asks for the number of "
    "days/weeks/months, etc., and the model makes off-by-one errors (e.g., "
    "predicting 19 days when the answer is 18), the model's response is still "
    "correct. "
    "\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\n"
    "Model Response: {response}\n\n"
    "Is the model response correct? Answer yes or no only."
)
KNOWLEDGE_UPDATE = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response contains some previous information along with an "
    "updated answer, the response should be considered as correct as long as the "
    "updated answer is the required answer."
    "\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\n"
    "Model Response: {response}\n\n"
    "Is the model response correct? Answer yes or no only."
)
PREFERENCE = (
    "I will give you a question, a rubric for desired personalized response, "
    "and a response from a model. Please answer yes if the response satisfies "
    "the desired response. Otherwise, answer no. The model does not need to "
    "reflect all the points in the rubric. The response is correct as long as "
    "it recalls and utilizes the user's personal information correctly."
    "\n\nQuestion: {question}\n\nRubric: {answer}\n\n"
    "Model Response: {response}\n\n"
    "Is the model response correct? Answer yes or no only."
)
ABSTENTION = (
    "I will give you an unanswerable question, an explanation, and a response "
    "from a model. Please answer yes if the model correctly identifies the "
    "question as unanswerable. The model could say that the information is "
    "incomplete, or some other information is given but the asked information "
    "is not."
    "\n\nQuestion: {question}\n\nExplanation: {answer}\n\n"
    "Model Response: {response}\n\n"
    "Does the model correctly identify the question as unanswerable? "
    "Answer yes or no only."
)

BY_TYPE = {
    "single-session-user": DEFAULT,
    "single-session-assistant": DEFAULT,
    "multi-session": DEFAULT,
    "temporal-reasoning": TEMPORAL,
    "knowledge-update": KNOWLEDGE_UPDATE,
    "single-session-preference": PREFERENCE,
}


def build_judge_prompt(
    *,
    question: str,
    answer: str,
    response: str,
    question_type: str | None,
    abstain: bool,
) -> str:
    template = ABSTENTION if abstain else BY_TYPE.get(question_type or "", DEFAULT)
    return (
        template.replace("{question}", question)
        .replace("{answer}", answer)
        .replace("{response}", response)
    )
