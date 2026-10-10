// Pas de console noire au demarrage sous Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    snap_studio_lib::run()
}
