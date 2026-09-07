// Run me with "GBA: Run Script From Active Editor" (play icon in the editor title)
// while a gba-kit debug session is paused. Same dialect as docs/scripting.md.
await wait({ frames: 120 });
await takeScreenshot({ name: 'title' });
console.log('display:', JSON.stringify(readDisplayControl()));
await press('start');
await wait({ frames: 60 });
await takeScreenshot({ name: 'after-start' });
console.log('sprites on screen:', readOAM().filter((s) => s.enabled).length);
console.log('pc =', getRegisters().r15.toString(16));
