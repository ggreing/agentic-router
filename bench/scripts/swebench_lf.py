"""Run the SWE-bench evaluation harness on Windows with LF line endings.

swebench writes the model patch (patch.diff) and the container test script (eval.sh) with
pathlib.Path.write_text(), which on Windows translates "\n" to "\r\n". Inside the Linux
instance container that makes `git apply` reject the patch and bash choke on the script.
This wrapper forces newline="\n" for write_text and then runs the harness unchanged.

usage: python swebench_lf.py <run_evaluation arguments...>
"""
import pathlib
import runpy
import sys

_write_text = pathlib.Path.write_text


def _write_text_lf(self, data, encoding=None, errors=None, newline=None):
    return _write_text(self, data, encoding=encoding, errors=errors, newline="\n" if newline is None else newline)


pathlib.Path.write_text = _write_text_lf
sys.argv = ["run_evaluation"] + sys.argv[1:]
runpy.run_module("swebench.harness.run_evaluation", run_name="__main__", alter_sys=True)
