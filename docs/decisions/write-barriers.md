# Decision: write barriers, not a playbook engine

The useful parts of a "think before you edit" culture are two predicates:

- you have observed the file you are about to change
- a multi-step `run` has a plan before the first write

Those are cheaper and more honest as loop gates than as a swarm/arena/playbook runtime. This harness does not ship an engine that generates those gates. It just checks them.
