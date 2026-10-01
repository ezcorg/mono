# Tart (github.com/cirruslabs/tart): macOS VMs on Virtualization.framework.
# The release is a signed, entitled app bundle; it must be used unmodified,
# so this only unpacks it and exposes the binary. Cirrus's Homebrew tap is
# broken against current Homebrew, which is why this is not a brew.
{ lib, stdenvNoCC, fetchurl }:

stdenvNoCC.mkDerivation rec {
  pname = "tart";
  version = "2.40.1";

  src = fetchurl {
    url = "https://github.com/cirruslabs/tart/releases/download/${version}/tart.tar.gz";
    hash = "sha256-Nj4nARVKgVXLwbtthFQwybQml9KhhrxJV0Rxyih320Y=";
  };

  sourceRoot = ".";
  dontPatchShebangs = true;
  dontFixup = true;   # keep the code signature intact

  installPhase = ''
    mkdir -p $out/Applications $out/bin
    cp -R tart.app $out/Applications/
    ln -s $out/Applications/tart.app/Contents/MacOS/tart $out/bin/tart
  '';

  meta = {
    description = "Run macOS and Linux VMs on Apple Silicon";
    homepage = "https://tart.run";
    license = lib.licenses.fsl11Mit;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "tart";
  };
}
