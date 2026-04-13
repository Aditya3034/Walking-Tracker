import Config from 'react-native-config';
const MAPBOX_TOKEN = Config.MAPBOX_TOKEN;

export function buildMapboxHTML(initialLat, initialLon, lineColor) {
  const lat = String(initialLat);
  const lon = String(initialLon);
  const color = lineColor || '#EE5514';

  return (
    '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">' +
    '<link href="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css" rel="stylesheet" />' +
    '<script src="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js"></script>' +
    '<style>* { margin:0; padding:0; box-sizing:border-box; } html,body,#map { width:100%; height:100%; } .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib { display:none !important; }</style>' +
    '</head><body><div id="map"></div><script>' +
    'mapboxgl.accessToken = "' + MAPBOX_TOKEN + '";' +
    'var map = new mapboxgl.Map({' +
    '  container: "map",' +
    '  style: "mapbox://styles/mapbox/light-v11",' +
    '  center: [' + lon + ', ' + lat + '],' +
    '  zoom: 17,' +
    '  interactive: false,' +
    '  attributionControl: false' +
    '});' +
    'var coords = [], allCoords = [], isTracking = false, mapReady = false, pendingColor = null;' +
    'var dotCoords = [' + lon + ', ' + lat + '];' +
    'map.on("load", function() {' +
    '  mapReady = true;' +
    '  map.getStyle().layers.forEach(function(layer) { if (layer.type === "symbol") map.removeLayer(layer.id); });' +
    '  map.addSource("route", { type: "geojson", data: geojson() });' +
    '  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "' + color + '", "line-width": 4 } });' +
    '  map.addSource("dot", { type: "geojson", data: dotGeojson() });' +
    '  map.addLayer({ id: "dot-outline", type: "circle", source: "dot", paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-opacity": 1 } });' +
    '  map.addLayer({ id: "dot-fill", type: "circle", source: "dot", paint: { "circle-radius": 7, "circle-color": "#2563eb", "circle-opacity": 1 } });' +
    '  if (pendingColor) { map.setPaintProperty("route", "line-color", pendingColor); pendingColor = null; }' +
    '});' +
    'function geojson() { return { type: "Feature", geometry: { type: "MultiLineString", coordinates: allCoords } }; }' +
    'function dotGeojson() { return { type: "Feature", geometry: { type: "Point", coordinates: dotCoords } }; }' +
    'function updateRoute() { if (mapReady) map.getSource("route").setData(geojson()); }' +
    'function updateDot() { if (mapReady) map.getSource("dot").setData(dotGeojson()); }' +
    'function handleMsg(e) {' +
    '  try {' +
    '    var msg = JSON.parse(e.data);' +
    '    if (msg.type === "position") {' +
    '      var ll = [msg.lon, msg.lat];' +
    '      dotCoords = ll; updateDot(); map.panTo(ll);' +
    '      if (isTracking) { coords.push(ll); allCoords[allCoords.length-1] = coords.slice(); updateRoute(); }' +
    '    } else if (msg.type === "start") {' +
    '      isTracking = true; coords = []; allCoords.push([]);' +
    '    } else if (msg.type === "resume") {' +
    '      isTracking = true; coords = []; allCoords.push([]);' +
    '    } else if (msg.type === "pause") {' +
    '      isTracking = false;' +
    '    } else if (msg.type === "finish") {' +
    '      isTracking = false;' +
    '      var flat = allCoords.reduce(function(a,b){return a.concat(b);}, []);' +
    '      if (flat.length > 1) {' +
    '        var lngs = flat.map(function(c){return c[0];}), lats = flat.map(function(c){return c[1];});' +
    '        map.fitBounds([[Math.min.apply(null,lngs),Math.min.apply(null,lats)],[Math.max.apply(null,lngs),Math.max.apply(null,lats)]], { padding: 40 });' +
    '      }' +
    '    } else if (msg.type === "clear") {' +
    '      coords = []; allCoords = []; isTracking = false; updateRoute();' +
    '    } else if (msg.type === "resize") {' +
    '      map.resize();' +
    '    } else if (msg.type === "setColor") {' +
    '      if (mapReady) { map.setPaintProperty("route", "line-color", msg.color); } else { pendingColor = msg.color; }' +
    '    }' +
    '  } catch(err) {}' +
    '}' +
    'document.addEventListener("message", handleMsg);' +
    'window.addEventListener("message", handleMsg);' +
    '</script></body></html>'
  );
}
