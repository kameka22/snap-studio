// No black console window at startup on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    snap_studio_lib::run()
}
