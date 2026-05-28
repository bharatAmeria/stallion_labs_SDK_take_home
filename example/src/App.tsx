/**
 * BitNet Example App
 *
 * Demonstrates:
 *  • Model download with live progress bar
 *  • Streaming chat UI (tokens arrive one-by-one)
 *  • Model management (list cached models, delete, check disk usage)
 */

import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from './screens/HomeScreen';
import ChatScreen from './screens/ChatScreen';
import ModelsScreen from './screens/ModelsScreen';

export type RootStackParamList = {
  Home: undefined;
  Chat: undefined;
  Models: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{
            headerStyle: { backgroundColor: '#1a1a2e' },
            headerTintColor: '#e2e8f0',
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: '#0f0f1a' },
          }}
        >
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={{ title: '⚡ BitNet SDK' }}
          />
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
            options={{ title: '💬 Chat' }}
          />
          <Stack.Screen
            name="Models"
            component={ModelsScreen}
            options={{ title: '📦 Model Manager' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
