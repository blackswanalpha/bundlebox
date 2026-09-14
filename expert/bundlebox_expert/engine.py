"""A forward-chaining rule engine, ~60 lines, no dependencies.

A rule is `when(facts) -> bool` and `then(facts) -> dict of new facts`. Rules
run to a fixpoint by salience then declaration order, and every firing is
recorded in `_fired` so a verdict can show its derivation. A rule that raises
is recorded as an error row, never retried in this pass, and never fatal: a
typo'd fact name must be visible in the derivation, not hidden as silence.
"""
from __future__ import annotations
import copy
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Rule:
    name: str
    when: Callable[[dict], bool]
    then: Callable[[dict], dict]
    salience: int = 0
    why: str = ""
    once: bool = True


@dataclass
class RuleSet:
    name: str
    rules: list = field(default_factory=list)

    def guarded(self, name, when, *, salience=0, why="", once=True):
        def wrap(fn):
            self.rules.append(Rule(name, when, fn, salience, why, once))
            return fn
        return wrap

    def rule(self, name, *, salience=0, why="", once=True):
        return self.guarded(name, lambda f: True, salience=salience, why=why, once=once)


def infer(rs: RuleSet, facts: dict, max_passes: int = 8) -> dict:
    f = copy.deepcopy(facts)
    f.setdefault("_fired", [])
    fired: set = set()
    order = sorted(enumerate(rs.rules), key=lambda ir: (-ir[1].salience, ir[0]))
    for _ in range(max_passes):
        changed = False
        for _, rule in order:
            if rule.once and rule.name in fired:
                continue
            try:
                if not rule.when(f):
                    continue
                new = rule.then(f) or {}
            except Exception as e:  # noqa: BLE001 — recorded, by design
                f["_fired"].append({"rule": rule.name, "error": f"{type(e).__name__}: {e}"})
                fired.add(rule.name)
                continue
            delta = {k: v for k, v in new.items() if f.get(k) != v}
            if not delta:
                continue
            f.update(delta)
            f["_fired"].append({"rule": rule.name, "why": rule.why, "set": sorted(delta)})
            fired.add(rule.name)
            changed = True
        if not changed:
            break
    return f
