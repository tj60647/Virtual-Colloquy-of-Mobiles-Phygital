/*
 * webbluetooth.d.ts
 * Project: Colloquy of Mobiles Virtual Simulation — Phygital
 * Author: Thomas J McLeish
 * License: MIT
 *
 * Minimal Web Bluetooth API type declarations for TypeScript.
 * Only the subset used by this project is declared; the full spec is at
 * https://webbluetoothcg.github.io/web-bluetooth/
 *
 * Important: the `export {}` at the bottom makes this file a TypeScript
 * module.  All interface declarations must therefore live inside
 * `declare global {}` or TypeScript will treat them as module-local and
 * page.tsx won't see them.
 */

declare global {
  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly value: DataView | null;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    writeValueWithoutResponse(value: BufferSource): Promise<void>;
    addEventListener(type: "characteristicvaluechanged", listener: (event: Event) => void): void;
    removeEventListener(type: "characteristicvaluechanged", listener: (event: Event) => void): void;
  }

  interface BluetoothRemoteGATTService {
    getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTServer {
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>;
  }

  interface BluetoothDevice extends EventTarget {
    readonly name: string | undefined;
    readonly gatt: BluetoothRemoteGATTServer | undefined;
    addEventListener(type: "gattserverdisconnected", listener: (event: Event) => void): void;
    removeEventListener(type: "gattserverdisconnected", listener: (event: Event) => void): void;
  }

  interface RequestDeviceOptions {
    filters?: Array<{ name?: string; services?: string[] }>;
    optionalServices?: string[];
  }

  interface Bluetooth {
    requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  }

  interface Navigator {
    bluetooth?: Bluetooth;
  }
}

export {};

