const {test}=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const renderer=require('react-test-renderer');
const fs=require('node:fs');
const vm=require('node:vm');
const {transformSync}=require('@babel/core');
global.IS_REACT_ACT_ENVIRONMENT=true;
const flatten=style=>Array.isArray(style)?Object.assign({},...style.map(flatten)):style||{};
const colors={primary:'#5059BC',danger:'#EA0606'};
const {code}=transformSync(fs.readFileSync('src/components/FormInput.js','utf8'),{babelrc:false,configFile:false,
  plugins:['@babel/plugin-transform-react-jsx','@babel/plugin-transform-modules-commonjs']});
const moduleExports={exports:{}};
vm.runInThisContext('(function(require,module,exports){'+code+'\n})')(name=>{
  if(name==='react')return React;
  if(name==='react-native')return {Platform:{OS:'web'},StyleSheet:{flatten},TextInput:'TextInput',View:'View'};
  if(name==='../context/ThemeContext')return {useTheme:()=>({theme:{colors}})};
  throw new Error(name);
},moduleExports,moduleExports.exports);
const {default:Input,FormInputContainer:Group}=moduleExports.exports;

test('standalone multiline field preserves value/callbacks and restores its border after blur',async()=>{
 let tree;const events=[];const change=()=>{};
 await renderer.act(async()=>{tree=renderer.create(React.createElement(Input,{style:{borderWidth:1,borderColor:'gray'},
  value:'Texto',multiline:true,onChangeText:change,onFocus:e=>events.push(e),onBlur:e=>events.push(e)}));});
 const input=()=>tree.root.findByType('TextInput');
 assert.equal(input().props.onChangeText,change);assert.equal(input().props.value,'Texto');
 const focus={type:'focus'},blur={type:'blur'};
 await renderer.act(async()=>input().props.onFocus(focus));
 assert.equal(flatten(input().props.style).borderColor,colors.primary);
 assert.equal(flatten(input().props.style).outlineStyle,'none');
 await renderer.act(async()=>input().props.onBlur(blur));
 assert.equal(flatten(input().props.style).borderColor,'gray');assert.deepEqual(events,[focus,blur]);
 await renderer.act(async()=>tree.unmount());
});

test('grouped field highlights only the outer border and preserves error color',async()=>{
 let tree;
 const render=borderColor=>React.createElement(Group,{style:{borderWidth:1,borderColor}},React.createElement(Input,{style:{flex:1}}));
 await renderer.act(async()=>{tree=renderer.create(render('gray'));});
 await renderer.act(async()=>tree.root.findByType('TextInput').props.onFocus({}));
 assert.equal(flatten(tree.root.findByType('View').props.style).borderColor,colors.primary);
 assert.equal(flatten(tree.root.findByType('TextInput').props.style).borderColor,undefined);
 await renderer.act(async()=>tree.update(render(colors.danger)));
 assert.equal(flatten(tree.root.findByType('View').props.style).borderColor,colors.danger);
 await renderer.act(async()=>tree.unmount());
});

test('read-only and disabled fields do not acquire editable focus styling',async()=>{
 for(const props of [{readOnly:true},{editable:false}]){
  let tree;await renderer.act(async()=>{tree=renderer.create(React.createElement(Input,{...props,style:{borderWidth:1,borderColor:'gray'}}));});
  await renderer.act(async()=>tree.root.findByType('TextInput').props.onFocus({}));
  assert.equal(flatten(tree.root.findByType('TextInput').props.style).borderColor,'gray');
  await renderer.act(async()=>tree.unmount());
 }
});
