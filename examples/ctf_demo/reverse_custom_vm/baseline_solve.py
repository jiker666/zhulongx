#!/usr/bin/env python3
"""Baseline solve for reverse_custom_vm — using Z3 constraint solver"""

# Even without z3, we can solve by inverting the transform

XOR_KEY = 0x37
ADD_SHIFT = 13

def solve_with_z3():
    """Solve using z3 if available"""
    try:
        from z3 import BitVec, Solver, sat

        with open("attachment/vm_spec.txt") as f:
            content = f.read()

        # Parse expected values
        import re
        m = re.search(r'expected = \[([^\]]+)\]', content)
        if not m:
            return "Could not parse expected table"
        expected = [int(x.strip(), 16) for x in m.group(1).split(',')]

        flag_len = len(expected)
        flag_chars = [BitVec(f'c{i}', 32) for i in range(flag_len)]
        s = Solver()

        for i, exp in enumerate(expected):
            c = flag_chars[i]
            # Forward transform: ((c ^ XOR_KEY) + ADD_SHIFT) & 0xFF
            transformed = ((c ^ XOR_KEY) + ADD_SHIFT) & 0xFF
            s.add(transformed == exp)
            # Constrain to printable ASCII
            s.add(c >= 0x20, c <= 0x7E)

        if s.check() == sat:
            model = s.model()
            flag = ''.join(chr(model[c].as_long()) for c in flag_chars)
            return flag
        return "UNSAT"
    except ImportError:
        return solve_manual()

def solve_manual():
    """Solve without z3 — inverse the transform"""
    with open("attachment/vm_spec.txt") as f:
        content = f.read()

    import re
    m = re.search(r'expected = \[([^\]]+)\]', content)
    if not m:
        return "Could not parse expected table"
    expected = [int(x.strip(), 16) for x in m.group(1).split(',')]

    # Inverse: ch = ((expected - ADD_SHIFT) ^ XOR_KEY) & 0xFF
    flag = ""
    for exp in expected:
        ch = ((exp - ADD_SHIFT) ^ XOR_KEY) & 0xFF
        flag += chr(ch)
    return flag

if __name__ == "__main__":
    result = solve_with_z3()
    print(result)
