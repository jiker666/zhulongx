import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;

import java.io.BufferedWriter;
import java.io.FileWriter;
import java.io.PrintWriter;

/**
 * Headless post-script: decompiles every function in the imported program and
 * writes one C pseudocode stream with "// ===== name @ address ====="
 * separators. Invoked by the ghidra-decompile wrapper; the first script
 * argument is the output path.
 */
public class DumpDecompiled extends GhidraScript {

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String outputPath = args.length > 0 ? args[0] : "decompiled.c";

        DecompInterface decompiler = new DecompInterface();
        DecompileOptions options = new DecompileOptions();
        options.setMaxPayloadMBytes(64);
        decompiler.setOptions(options);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) {
            throw new RuntimeException("decompiler failed to open program: " +
                decompiler.getLastMessage());
        }

        try (PrintWriter out = new PrintWriter(new BufferedWriter(new FileWriter(outputPath)))) {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            int count = 0;
            while (functions.hasNext()) {
                Function function = functions.next();
                if (monitor.isCancelled()) {
                    break;
                }
                out.println("// ===== " + function.getName() + " @ " + function.getEntryPoint() + " =====");
                DecompileResults results = decompiler.decompileFunction(function, 90, monitor);
                if (results != null && results.decompileCompleted()) {
                    out.println(results.getDecompiledFunction().getC());
                } else {
                    out.println("// decompilation failed: " +
                        (results == null ? "no results" : results.getErrorMessage()));
                }
                count++;
            }
            out.println("// ===== end (" + count + " functions) =====");
        } finally {
            decompiler.dispose();
        }
    }
}
