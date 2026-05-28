/**
 * Turbo Module spec for react-native-bitnet.
 *
 * This file is the codegen source of truth. React Native's codegen reads it to
 * generate the native C++ / Java / ObjC bridge glue automatically at build time.
 *
 * ⚠️  Only use types supported by React Native codegen here (no generics, no
 * union types in function signatures). Keep this file strictly to the native
 * boundary — JS-friendly wrappers live in BitNetClient.ts.
 */
import { TurboModuleRegistry } from 'react-native';
export default TurboModuleRegistry.getEnforcing('RNBitNet');
