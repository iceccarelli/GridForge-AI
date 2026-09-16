# inbox — where a patch arrives

Drop a `.patch` file here — or anywhere in the repository, including the root —
then run:

```bash
bash scripts/apply-inbox.sh
```

It sweeps any `.patch` off the repository root into this folder, applies each patch
in order, runs the tests, and commits the result **with the patch file removed in
the same commit**. The repository never accumulates them.

**You do not have to put the file here by hand.** The GitHub web uploader has no
usable folder picker and drops everything at the root, so the script moves it for
you and commits the move. That is a workflow; `git mv` every time was not.

**A pre-existing failure will not revert your patch.** The script records which
tests are already red before it applies anything and rolls back only on *new*
failures. Anything already red is printed by name, at the start and at the end, and
still has to be fixed — it just is not your patch's fault.

## Why this exists rather than the repository root

Patches were being uploaded to the root through the GitHub web interface. Three
things follow from that, and all three happened:

1. **`.gitignore` does not help.** A web upload commits directly; `/*.patch` only
   stops an *untracked* file being added by `git add`. Once a file is tracked, the
   ignore rule is silent. So the patches accumulated on `main`, in public.
2. **`git pull` starts refusing.** A file at the root that you have also touched
   locally — even just `chmod +x` — makes the merge abort with "local changes would
   be overwritten", and every command after it fails for a reason that has nothing
   to do with the real problem.
3. **The wrong file eventually lands.** A tool belonging to an entirely different
   project was uploaded here and pushed to public `main`, because the root is where
   things were being dropped and nothing was watching the root.

`inbox/` is tracked so the upload has somewhere to land, and empty so nothing
accumulates. `tests/test_stack_consistency.py` fails if a stray file appears at the
repository root, and fails if a patch is left in here after applying.
