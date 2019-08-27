
import { Platform, Base6502Platform, BaseMAMEPlatform, getOpcodeMetadata_6502, getToolForFilename_6502 } from "../baseplatform";
import { PLATFORMS, RAM, newAddressDecoder, padBytes, noise, setKeyboardFromMap, AnimationTimer, RasterVideo, Keys, makeKeycodeMap, dumpRAM, getMousePos, EmuHalt, KeyFlags, _setKeyboardEvents } from "../emu";
import { hex, lzgmini, stringToByteArray, lpad, rpad, rgb2bgr } from "../util";

declare var jt; // for 6502

// http://www.6502.org/trainers/buildkim/kim.htm
// http://users.telenet.be/kim1-6502/
// http://retro.hansotten.nl/uploads/6502docs/usrman.htm#F312
// http://www.zimmers.net/anonftp/pub/cbm/documents/chipdata/6530.pdf
// http://archive.6502.org/datasheets/mos_6530_rriot_preliminary_aug_1975.pdf
// https://github.com/mamedev/mame/blob/master/src/mame/drivers/kim1.cpp
// https://github.com/mamedev/mame/blob/c5426f2fabc220be2efc2790ffca57bde108cbf2/src/devices/machine/mos6530.cpp

var KIM1_PRESETS = [
  {id:'hello.dasm', name:'Hello World (ASM)'},
];

const KIM1_KEYCODE_MAP = makeKeycodeMap([
]);

const KIM1_KEYMATRIX_NOSHIFT = [
  Keys.VK_DELETE, Keys.VK_ENTER, Keys.VK_RIGHT, Keys.VK_F7,	Keys.VK_F1, Keys.VK_F3, Keys.VK_F5, Keys.VK_DOWN,
  Keys.VK_3, Keys.VK_W, Keys.VK_A, Keys.VK_4,			Keys.VK_Z, Keys.VK_S, Keys.VK_E, Keys.VK_SHIFT,
  Keys.VK_5, Keys.VK_R, Keys.VK_D, Keys.VK_6,			Keys.VK_C, Keys.VK_F, Keys.VK_T, Keys.VK_X,
  Keys.VK_7, Keys.VK_Y, Keys.VK_G, Keys.VK_8,			Keys.VK_B, Keys.VK_H, Keys.VK_U, Keys.VK_V,
  Keys.VK_9, Keys.VK_I, Keys.VK_J, Keys.VK_0,			Keys.VK_M, Keys.VK_K, Keys.VK_O, Keys.VK_N,
  null/*Keys.VK_PLUS*/, Keys.VK_P, Keys.VK_L, Keys.VK_MINUS,	Keys.VK_PERIOD, null/*Keys.VK_COLON*/, null/*Keys.VK_AT*/, Keys.VK_COMMA,
  null/*Keys.VK_POUND*/, null/*TIMES*/, Keys.VK_SEMICOLON, Keys.VK_HOME, Keys.VK_SHIFT/*right*/, Keys.VK_EQUALS, Keys.VK_TILDE, Keys.VK_SLASH,
  Keys.VK_1, Keys.VK_LEFT, Keys.VK_CONTROL, Keys.VK_2,		Keys.VK_SPACE, Keys.VK_ALT, Keys.VK_Q, null/*STOP*/,
];

const KEYBOARD_ROW_0 = 0;

const cpuFrequency = 1000000;
const romLength = 0x1000;

class RRIOT_6530 {

  regs = new Uint8Array(16);
  ina : number = 0;
  inb : number = 0;

  read(a:number) : number {
    //console.log('read', hex(a), hex(this.regs[a]));
    return this.regs[a];
  }

  write(a:number,v:number) {
    this.regs[a] = v;
    //console.log('write', hex(a), hex(v));
  }
  
  input_a() { return this.ina & ~this.regs[1]; }
  input_b() { return this.inb & ~this.regs[1]; }
  output_a() { return (this.regs[0] ^ 0xff) | this.regs[1]; }
  output_b() { return (this.regs[2] ^ 0xff) | this.regs[3]; }
}

class KIM1Platform extends Base6502Platform implements Platform {

  mainElement : HTMLElement;
  cpu;
  ram  : Uint8Array;
  bios : Uint8Array;
  bus;
  timer : AnimationTimer;
  inputs = new Uint8Array(16);
  rriot1 : RRIOT_6530 = new RRIOT_6530();
  rriot2 : RRIOT_6530 = new RRIOT_6530();
  digits = [];
  
  constructor(mainElement : HTMLElement) {
    super();
    this.mainElement = mainElement;
  }

  getPresets() {
    return KIM1_PRESETS;
  }
  
  getKeyboardMap() { return null; /* TODO: KIM1_KEYCODE_MAP;*/ }

  getKeyboardFunction() {
    return (key,code,flags) => {
      //console.log(key,code,flags);
      var keymap = KIM1_KEYMATRIX_NOSHIFT;
      for (var i=0; i<keymap.length; i++) {
        if (keymap[i] && keymap[i].c == key) {
          let row = i >> 3;
          let col = i & 7;
          // is column selected?
          if (flags & KeyFlags.KeyDown) {
            this.inputs[KEYBOARD_ROW_0 + row] |= (1<<col);
          } else if (flags & KeyFlags.KeyUp) {
            this.inputs[KEYBOARD_ROW_0 + row] &= ~(1<<col);
          }
          console.log(key, row, col, hex(this.inputs[KEYBOARD_ROW_0 + row]));
          break;
        }
      }
    }
  }
  
  readIO_1(a:number) : number {
    return this.rriot1.read(a);
  }
  
  writeIO_1(a:number, v:number) {
    this.rriot1.write(a,v);
  }
  
  readIO_2(a:number) : number {
    switch (a & 0xf) {
      case 0x0:
        let cols = 0;
        for (let i=0; i<8; i++)
          if ((this.rriot2.regs[0] & (1<<i)) == 0)
            cols |= this.inputs[KEYBOARD_ROW_0 + i];
        //if (cols) console.log(this.rriot1.regs[0], cols);
        this.rriot2.ina = cols ^ 0xff;
    }
    return this.rriot2.read(a);
  }
  
  writeIO_2(a:number, v:number) {
    this.rriot2.write(a,v);
    // update LED
    let digit = this.rriot2.output_a();
    let segments = this.rriot2.output_b();
    console.log(digit, segments);
  }
  
  start() {
    this.cpu = new jt.M6502();
    this.ram = new Uint8Array(0x1800);
    this.bios = new lzgmini().decode(stringToByteArray(atob(KIM1_BIOS_LZG)));
    this.bus = {
      read: newAddressDecoder([
        [0x1700, 0x173f, 0x000f, (a) => { return this.readIO_1(a); }],
        [0x1740, 0x177f, 0x000f, (a) => { return this.readIO_2(a); }],
        [0x0000, 0x17ff, 0x1fff, (a) => { return this.ram[a]; }],
        [0x1800, 0x1fff, 0x07ff, (a) => { return this.bios[a]; }],
      ], {gmask:0x1fff}),
      write: newAddressDecoder([
        [0x1700, 0x173f, 0x000f, (a,v) => { return this.writeIO_1(a,v); }],
        [0x1740, 0x177f, 0x000f, (a,v) => { return this.writeIO_2(a,v); }],
        [0x0000, 0x17ff, 0x1fff, (a,v) => { this.ram[a] = v; }],
      ], {gmask:0x1fff}),
    };
    this.cpu.connectBus(this.bus);
    this.timer = new AnimationTimer(60, this.nextFrame.bind(this));
    // create digits display
    let div = $('<div class="emuvideo"/>').appendTo(this.mainElement);
    div[0].tabIndex = -1;               // Make it focusable
    for (let i=0; i<6; i++) {
      let id = "kim_digit_" + i;
      let el = $('<span style="font-size:3em;font-family:monospace;color:red">0</span>').attr('id',id).appendTo(div);
      this.digits.push(el);
    }
    _setKeyboardEvents(div[0], this.getKeyboardFunction());
  }

  advance(novideo : boolean) {
    var debugCond = this.getDebugCallback();
    for (var i=0; i<cpuFrequency/60; i++) {
      if (debugCond && debugCond()) {
        debugCond = null;
        break;
      }
      this.cpu.clockPulse();
    }
  }

  loadROM(title, data) {
    let rom = padBytes(data, romLength);
    this.ram.set(rom, 0x400);
    this.reset();
  }

  loadBIOS(title, data) {
    this.bios = padBytes(data, 0x800);
    this.reset();
  }

  isRunning() {
    return this.timer.isRunning();
  }

  pause() {
    this.timer.stop();
  }

  resume() {
    this.timer.start();
  }

  reset() {
    this.cpu.reset();
    this.cpu.clockPulse(); // TODO: needed for test to pass?
  }

  // TODO: don't log if profiler active
  readAddress(addr : number) {
    return this.bus.read(addr) | 0;
  }

  loadState(state) {
    this.unfixPC(state.c);
    this.cpu.loadState(state.c);
    this.fixPC(state.c);
    this.ram.set(state.b);
    this.loadControlsState(state);
  }
  saveState() {
    return {
      c:this.getCPUState(),
      b:this.ram.slice(0),
      in:this.inputs.slice(0)
    };
  }

  loadControlsState(state) {
    this.inputs.set(state.in);
  }

  saveControlsState() {
    return {
      in:this.inputs.slice(0)
    };
  }

  getCPUState() {
    return this.fixPC(this.cpu.saveState());
  }
  getMemoryMap = function() { return { main:[
      {name:'RAM',          start:0x0000,size:0x1400,type:'ram'},
      {name:'6530',         start:0x1700,size:0x0040,type:'io'},
      {name:'6530',         start:0x1740,size:0x0040,type:'io'},
      {name:'RAM',          start:0x1780,size:0x0080,type:'ram'},
      {name:'BIOS',         start:0x1800,size:0x0800,type:'rom'},
  ] } };
}

///

PLATFORMS['kim1'] = KIM1Platform;

// https://github.com/jefftranter/6502/blob/master/asm/KIM-1/ROMs/kim.s
const KIM1_BIOS_LZG = `TFpHAAAIAAAABY3ivWkoAQsOJSiprY3sFyAyGaknjUIXqb+NQxeiZKkWIHoZytD4qSoo4a35FyBhGa31FyBeGa32KKPtF833F63uF+34F5AkqS8lXeclnegooqICqQQOBTgAhfqF+0xPHCDsJXAg6hlMMxgPGamNDgVrTI3vF61xGI3wF61yGI3xF6kHDgJ8/43pFyBBGk7pFw3pFyUErekXyRbQ7aIKICQaJQHfytD2JUIq8AYlBtHw8yDzGc35F/ANrfkXyQAlDf/wF9CcJQ0gTBmN7RcOBQHuF0z4GCXEKKSiAiV9L/AUIAAa0CPK0PElDEzsFw4CnCWhzecX0Awo4ugX0ASpAPACqf8OBcWt9ReN7Ret9heN7hepYI3vF6kAjecXjegXYKgYbSUB5xet6BdpACUJmGAgTBmoSigBIG8ZmChiYCkPyQoYMAJpB2kwjukXjOoXoAggnhlKsAYooUyRGSDEKEKI0Ouu6Res6hdgoglILEcXEPupfo1EF6mnjUIXDgkHDiKqytDfaGCiBg4FHsMODB4lhw4HHu7tF9AD7u4XYCAkGiAAGiikYMkwMB7JRxAayUAwAxhpCSooAaQEKi7pF4jQ+a3pF6AAYMhgjusXoggOIovqFw3qF43qF8rQ8a3qFypKrusXYCxCFxD7rUYXoP+MKIEUiND9JQow+zjtDgYLByULSf8pgGAOSFsOBJeaDgymJYclW0x1Gv8oHygfKB4oGWsaKCKF82iF8WiF74X6aIXwhfuE9Ib1uobyIIgeTE8cbPoXbP4Xov+aJYmp/43zF6kBLEAX0Bkw+an8GGkBkAPu8xesQBcQ843yDkIbah4gjB4l2x4gLx6iCiAxHkyvHakAhfiF+SBaHskB8AYgrB9M2x0gGR/Q0yWi8MwlBPD0KILvIGofyRUQu8kU8ETJEPAsyREoYRLwL8kT8DEKKAGF/KIEpP/QCrH6BvwqkfpMwxwKJvom+8rQ6vAIqQHQAqkAhf8OgmZjHyihTMgdpe+F+qXwDoR6Wh7JO9D5JRr3hfYgnR+qIJEfKMGF+yjl+ijhivAPJQORJUMlO8rQ8uglB8X20BcowvfQE4rQuaIMDkOaDgLPTxwlD6IR0O4OBNYoofaF9yAvHqk7IKAepfrN9xel+w6iGRipACA7HiDMHyAeHqX2JQOl9yiBTGQcqRiqJVGRJVGgALH6DgUFDgJy8A4IIeb40ALm+UxIHSV6Lx4lJCCeDgcnng4CQCUqTKwdpvKapftIpfpIpfFIpvWk9KXzQMkg8MrJf/AbyQ3w28kK8BzJLvAmyUfw1clR8ArJTPAJTGocDiIgQh1M5xw4pfrpAYX6sALG+0ysHaAApfiR+kzCHaX7DgSOpQ4FlmCiB73VHyCgHsoQ92CF/A6D00wepfwogw6K1UygHob9oggORAQiMPkg1B4g6x6tQBcpgEb+Bf6F/iUJytDvJQym/aX+KkpgogGG/6IAjkEXoj+OQxeiB45CF9h4YKkghf6G/SUkrUIXKf4OInLUHqIIJYVG/mkAJcnK0O4lCgkBJcam/WCt8xeN9Bet8hc46QGwA870F6z0FxDzDggPSk70F5DjCYCw4KADogGp/45CF+joLUAXiND1oAeMQhcJgEn/YA4iXIX5qX+NQReiCaADufgADgPmSB8lAikPKOGI0OslMakAJRlM/h6E/Ki55x+gAIxAFyUOjUAXoH+I0P3o6KT8YOb60ALm+2CiIaABIAIf0AfgJ9D1qRVgoP8KsAPIEPqKKQ9KqpgQAxhpB8rQ+mAYZfeF96X2aQCF9mAgWh4grB8opKX4DqKkG8lHEBcOqaSgBCom+Cb5iA7iZWCl+IX6pfmF+2AAKAMKDU1JSyATUlJFIBO/htvP5u39h//v9/y53vnx////HBwiHB8c`;

