import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Dimensions } from 'react-native';
import Svg, { Ellipse } from 'react-native-svg';

const { width: W, height: H } = Dimensions.get('window');

// Logo proportions: rx=14 ry=18 in an 80-unit square → ratio 14:18
const EYE_RX   = 40;
const EYE_RY   = Math.round(EYE_RX * (18 / 14)); // ~51
const EYE_GAP  = 8;
const LEFT_CX  = W / 2 - EYE_RX - EYE_GAP / 2;
const RIGHT_CX = W / 2 + EYE_RX + EYE_GAP / 2;
const EYE_CY   = H * 0.44;


const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

export default function SplashScreen({ onComplete }) {
  const blinkRy = useRef(new Animated.Value(EYE_RY)).current;
  const fadeOut = useRef(new Animated.Value(1)).current;

  const scheduleBlink = () => {
    const delay = 1500 + Math.random() * 2000;
    setTimeout(() => {
      Animated.sequence([
        Animated.timing(blinkRy, { toValue: 1,      duration: 80,  useNativeDriver: false }),
        Animated.timing(blinkRy, { toValue: EYE_RY, duration: 80,  useNativeDriver: false }),
      ]).start(scheduleBlink);
    }, delay);
  };

  useEffect(() => {
    scheduleBlink();

    setTimeout(() => {
      Animated.timing(fadeOut, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start(() => onComplete?.());
    }, 2400);
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity: fadeOut }]}>
      <Svg style={StyleSheet.absoluteFill} width={W} height={H}>
        <AnimatedEllipse cx={LEFT_CX}  cy={EYE_CY} rx={EYE_RX} ry={blinkRy} fill="white" />
        <AnimatedEllipse cx={RIGHT_CX} cy={EYE_CY} rx={EYE_RX} ry={blinkRy} fill="white" />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#111111',
    zIndex: 999,
  },
});
