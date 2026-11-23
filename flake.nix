{
  description = "schiffy.io photography portfolio";

  inputs.btrc.url = "github:schiffy91/btrc";
  inputs.nixpkgs.follows = "btrc/nixpkgs";

  outputs = { self, btrc, nixpkgs }:
    let
      eachSystem = nixpkgs.lib.genAttrs [
        "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux"
      ];
    in {
      packages = eachSystem (system: let
        pkgs = nixpkgs.legacyPackages.${system};
        gallery = btrc.lib.buildPackage pkgs {
          name = "schiffy-gallery";
          src = ./generator;
          programs.gallery = "Gallery.btrc";
          programs.previews = "Previews.btrc";
          linkPlan = true;
        };
      in {
        inherit gallery;
        default = pkgs.runCommand "schiffy-portfolio" {} ''
          cp -R ${./docs} "$out"
          chmod u+w "$out"
          ${gallery}/bin/gallery "$out" ${./gallery.html}
        '';
      });
      apps = eachSystem (system: {
        default = { type = "app"; program = "${self.packages.${system}.gallery}/bin/gallery"; };
        previews = { type = "app"; program = "${self.packages.${system}.gallery}/bin/previews"; };
      });
      checks = eachSystem (system: {
        published-page = nixpkgs.legacyPackages.${system}.runCommand "check-published-page" {} ''
          diff -u ${./docs/index.html} ${self.packages.${system}.default}/index.html
          touch "$out"
        '';
      });
      devShells = eachSystem (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [ self.packages.${system}.gallery btrc.packages.${system}.btrcpy ];
        };
      });
    };
}
