#!/usr/bin/env sh
set -eu

APP_DIR="${HOME}/.local/share/select-reader"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"

mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR"
cp select-reader.py "$APP_DIR/select-reader.py"
chmod +x "$APP_DIR/select-reader.py"

cat > "$BIN_DIR/select-reader" <<EOF
#!/usr/bin/env sh
exec "$APP_DIR/select-reader.py" "\$@"
EOF
chmod +x "$BIN_DIR/select-reader"

cat > "$DESKTOP_DIR/select-reader.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Select Reader
Comment=Read highlighted text aloud
Exec=$BIN_DIR/select-reader
Terminal=false
Categories=Utility;Accessibility;
StartupNotify=true
EOF

printf '%s\n' "Installed Select Reader."
printf '%s\n' "Run it from your app launcher, or run: select-reader"
