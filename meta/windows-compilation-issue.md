The root cause is clear. The cel-cxx-ffi v0.2.1 crate (an external dependency) builds cel-cpp via      
  Bazel, and on Windows the Bazel build is pulling in protobuf's C# compiler plugin as a transitive      
  dependency. That plugin references the header csharp_repeated_primitive_field.h which was removed in   
  newer protobuf versions, causing the build failure.                                                    
                                                                                                         
  This is entirely within the upstream cel-cxx / cel-build-utils crate — not your code. Here are your    
  options:                                                                                               
                                                                                                         
  Option 1: File an upstream issue (recommended)                                                         
                                                                                                         
  The fix belongs in https://github.com/xjasonli/cel-cxx. The cel-windows/.bazelrc needs to exclude
  protobuf's C# compiler target from the build. Something like:                                          
  build:msvc --per_file_copt=external/protobuf.*/src/google/protobuf/compiler/csharp/.*@/w               
  or the upstream MODULE.bazel needs to pin a compatible protobuf version.                               
                                                                                                         
  Option 2: Cargo patch with a fixed cel-build-utils                                                     
                                                                                                         
  You could fork cel-build-utils, fix the Windows Bazel config, and add a [patch] in your workspace
  Cargo.toml:
  [patch.crates-io]                                                                                      
  cel-build-utils = { git = "https://github.com/your-fork/cel-cxx", ... }                                
                                                                                                         
  Option 3: Skip the CEL C++ build on Windows                                                            
                                                                                                         
  If you don't actually need CEL evaluation on Windows (e.g., only Linux in production), you can         
  conditionally exclude it. The build script checks for CEL_CXX_FFI_SKIP_BUILD env var, but that would   
  break functionality.                                                                                   
                                                                                                         
  A more practical approach would be to make cel-cxx an optional, platform-gated dependency:             
                                                                                                         
  [target.'cfg(not(windows))'.dependencies]                                                              
  cel-cxx = "0.2.1"                                                                                      
                                                                                                         
  and #[cfg(not(windows))] gate the code that uses it. This depends on whether you need CEL on Windows.  
                                                                                                         
  Option 4: Check for a newer version

  Let me check if there's a newer release that may have fixed this.

● Web Search("cel-cxx-ffi crate windows msvc build fix 2025 2026")
  ⎿  Did 1 search in 7s
                                                                                                         
● Web Search("site:github.com xjasonli/cel-cxx issues windows msvc protobuf csharp")
  ⎿  Did 1 search in 7s                                                                                  
                                                                     
● Fetch(https://crates.io/crates/cel-cxx/versions)                                                       
  ⎿  Received 3.1KB (200 OK)                                                                             
                                                                                                         
● Bash(cargo search cel-cxx 2>/dev/null | head -5)                                                       
  ⎿  cel-cxx = "0.2.4"           # A high-performance, type-safe Rust interface for Common Expressio     
     n Language (CEL), build on top of …                                                                 
     cel-cxx-ffi = "0.2.4"       # FFI bindings for the cel-cxx crate                                    
     cel-cxx-macros = "0.2.4"    # Macros for the cel-cxx crate                                          
                                                                                                         
● There's a newer version — 0.2.4 vs your 0.2.1. The simplest thing to try first is upgrading:           
                                                                                                         
  cel-cxx = "0.2.4"                                                                                      
                                                                                                         
  The upstream author may have already fixed this. If not, the core issue is that Bazel is building      
  protobuf's C# compiler plugin (which references a removed header csharp_repeated_primitive_field.h) as 
  a transitive dependency that isn't actually needed for CEL.                                            
                                                                                                         
  Summary of options, in order of effort:                                                                

  1. Upgrade to cel-cxx 0.2.4 — try this first, may already be fixed
  2. File an issue at https://github.com/xjasonli/cel-cxx — if 0.2.4 still fails
  3. Platform-gate the dependency — if you don't need CEL on Windows, use
  [target.'cfg(not(windows))'.dependencies]
  4. Cargo [patch] — fork cel-build-utils and fix the Windows Bazel config to exclude protobuf's C#
  targets

  Would you like to try the version upgrade?

  Sources:
  - https://crates.io/crates/cel-cxx
  - https://github.com/xjasonli/cel-cxx
  - https://github.com/protocolbuffers/protobuf/issues/22794
