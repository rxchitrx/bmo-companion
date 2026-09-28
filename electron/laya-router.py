"""Local typed-choice router. It never executes tasks or handles credentials."""
import json
import sys

import laya_mlx as laya

QUESTIONS = {
    "route": {
        "type": "choice",
        "instructions": "Select the action the person is asking for. A question or ordinary reply without an external action is conversation.",
        "criteria": {
            "conversation": "Talk, answer a question, or explain something without acting in an external system",
            "project": "Select or switch the active coding project without changing files",
            "coding": "Inspect, create, fix, or edit source code in a software project",
            "connector": "Read or change connected email, calendar, reminders, tasks, or other personal service",
            "browser": "Navigate a website or operate a browser",
            "computer": "Operate a desktop application or the Mac user interface",
        },
    }
}

agent = laya.load("aac6fef/laya-mlx", revision="20aed815fc6acde75733882e7ec0e3f28aeb9717")
for line in sys.stdin:
    try:
        request = json.loads(line)
        text = str(request.get("text", ""))[:2000]
        answer = agent.predict(text, QUESTIONS)["answers"]["route"]
        print(json.dumps({"id": request.get("id"), "route": answer["choice"], "confidence": answer["confidence"]}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id") if "request" in locals() else None, "error": type(error).__name__}), flush=True)
