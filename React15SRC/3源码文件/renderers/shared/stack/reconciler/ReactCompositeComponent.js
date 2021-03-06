/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactCompositeComponent
 */

'use strict';

var React = require('React');
// 提供ReactComponentEnvironment.replaceNodeWithMarkup方法，用于替换挂在的DOM元素
var ReactComponentEnvironment = require('ReactComponentEnvironment');
// 开发环境下，ReactClass组件被实例化或者其render方法被调用时，向ReactCurrentOwner.current添加当前实例this
var ReactCurrentOwner = require('ReactCurrentOwner');
// 调试用
var ReactErrorUtils = require('ReactErrorUtils');
// 以对象形式存储组件实例
var ReactInstanceMap = require('ReactInstanceMap');
// 调试用
var ReactInstrumentation = require('ReactInstrumentation');
// 用于判断节点类型。ReactComponentElement：1， ReactDOMElement：0.其他返回2
var ReactNodeTypes = require('ReactNodeTypes');
// 用于挂在、移除、更新组件实例。作为方法的发起者，如ReactReconciler.mountComponent
var ReactReconciler = require('ReactReconciler');

if (__DEV__) {
  var checkReactTypeSpec = require('checkReactTypeSpec');
}
// 空对象，用于Object.freeze()冻结为不可修改、不可拓展
var emptyObject = require('emptyObject');
// invariant(condition,format,a,b,c,d,e,f) condition为否值，替换format中的"%s"，并throw error报错    
var invariant = require('invariant');
// shallowEqual(A, B)比较值相等，及浅比较键值相等
var shallowEqual = require('shallowEqual');
// 判断组件重绘时，是采用更新组件实例的方式(返回true)；还是销毁实力后重新创建实例的方式（false）。如果组件元素的构造函数或key值不同，销毁实例后再创建
var shouldUpdateReactComponent = require('shouldUpdateReactComponent');
// warning(condition,format) condition为否值，替换format中的"%s"，并console.error警告   
var warning = require('warning');

import type { ReactPropTypeLocations } from 'ReactPropTypeLocations';

// 区分纯函数无状态组件、PureComponent纯组件、Component组件的标识符  
var CompositeTypes = {
  ImpureClass: 0, // 组件，继承React.Component
  PureClass: 1, // 纯组件，继承React.PureComponent.不能设置shouldComponentUpdate方法，重绘时判断props,state是否变更
  StatelessFunctional: 2, // 纯函数无状态组件， function(props, content, updateQueue){}形式
};

// 将无状态组件function(props, content, updateQueue){}形式，包装为带有render原型方法的构造函数形式
function StatelessComponent(Component) {
}
StatelessComponent.prototype.render = function() {
  // 获取无状态组件的type类型(构造函数)
  var Component = ReactInstanceMap.get(this)._currentElement.type;
  // 重新使用参数初始化
  var element = Component(this.props, this.context, this.updater);
  warnIfInvalidElement(Component, element);
  return element;
};

// 检验无状态组件返回值必须是ReactElement,以及不能设置childContextTypes静态属性
function warnIfInvalidElement(Component, element) {
  if (__DEV__) {
    warning(
      element === null || element === false || React.isValidElement(element),
      '%s(...): A valid React element (or null) must be returned. You may have ' +
      'returned undefined, an array or some other invalid object.',
      Component.displayName || Component.name || 'Component'
    );
    warning(
      !Component.childContextTypes,
      '%s(...): childContextTypes cannot be defined on a functional component.',
      Component.displayName || Component.name || 'Component'
    );
  }
}
// 校验是否纯组件或组件。返回false表示非状态组件[或ReactClass的工厂函数处理]。
function shouldConstruct(Component) {
  return !!(Component.prototype && Component.prototype.isReactComponent);
}
function isPureComponent(Component) {
  return !!(Component.prototype && Component.prototype.isPureReactComponent);
}

// 开发环境下带调试方式执行fn  
// Separated into a function to contain deoptimizations caused by try/finally.
function measureLifeCyclePerf(fn, debugID, timerType) {
  if (debugID === 0) {
    // Top-level wrappers (see ReactMount) and empty components (see
    // ReactDOMEmptyComponent) are invisible to hooks and devtools.
    // Both are implementation details that should go away in the future.
    return fn();
  }

  ReactInstrumentation.debugTool.onBeginLifeCycleTimer(debugID, timerType);
  try {
    return fn();
  } finally {
    ReactInstrumentation.debugTool.onEndLifeCycleTimer(debugID, timerType);
  }
}

/**
 * ------------------ The Life-Cycle of a Composite Component ------------------
 *
 * - constructor: Initialization of state. The instance is now retained.
 *   - componentWillMount
 *   - render
 *   - [children's constructors]
 *     - [children's componentWillMount and render]
 *     - [children's componentDidMount]
 *     - componentDidMount
 *
 *       Update Phases:
 *       - componentWillReceiveProps (only called if parent updated)
 *       - shouldComponentUpdate
 *         - componentWillUpdate
 *           - render
 *           - [children's constructors or receive props phases]
 *         - componentDidUpdate
 *
 *     - componentWillUnmount
 *     - [children's componentWillUnmount]
 *   - [children destroyed]
 * - (destroyed): The instance is now blank, released by React and ready for GC.
 *
 * -----------------------------------------------------------------------------
 */

/**
 * An incrementing ID assigned to each component when it is mounted. This is
 * used to enforce the order in which `ReactUpdates` updates dirty components.
 *
 * @private
 */
var nextMountID = 1; // 当每一个组件被挂在后，会分配一个nextMountID。这用于强制执行“ReactUpdates”更新脏组件的顺序。

/**
 * @lends {ReactCompositeComponent.prototype}
 */
// 自定义组件实例化、挂载、移除、更新实现
var ReactCompositeComponent = {

  // 实例化
  construct: function(element) {
    this._currentElement = element; // ReactCompositeComponent.配置了组件的构造函数、props属性等。
    this._rootNodeID = 0; 
    this._compositeType = null; // 区分纯函数无状态主键，继承与PureComponent的纯组件以及继承React.Component的组件
    this._instance = null; // ReactComponent的实例
    this._hostParent = null; // 文档元素，作为组件元素的父节点
    this._hostContainerInfo = null;

    // See ReactUpdateQueue
    this._updateBatchNumber = null;
    this._pendingElement = null; // ReactDOM.render方法渲染时包裹元素由react组件渲染，_pendingElement存储待渲染元素
    this._pendingStateQueue = null; // 组件调用setState、replaceState方法，通过ReactUpdateQueue将更迭后的state推入state数据
    this._pendingReplaceState = false; // 判断组件是否通过replaceState方法向_pendingStateQueue推入数据
    this._pendingForceUpdate = false; // 组件调用forceUpdate赋值为真  

    this._renderedNodeType = null; // 节点类型，区分ReactCompositeComponent,ReactDOMElement, ReactDOMTextElement
    this._renderedComponent = null; // render方法内子组件实例
    this._context = null; // 赋值给组件的context属性
    // 当组件挂载时，会分配一个递增编号，表示执行ReactUpdates时更新的顺序
    this._mountOrder = 0; // 挂在的第几个组件,来自于nextMountID自增的值
    this._topLevelWrapper = null; // 顶层包裹元素

    // See ReactUpdates and ReactUpdateQueue.
    this._pendingCallbacks = null; 

    // ComponentWillUnmount shall only be called once
    this._calledComponentWillUnmount = false;

    if (__DEV__) {
      this._warnedAboutRefsInRender = false;
    }
  },

  // 发起： ReactReconciler.mountComponent进入
  // param-transaction: 默认为ReactUpdates.ReactReconcileTransaction.即ReactReconcileTransaction模块。用于在组件挂在前后执行指定的钩子函数
            //(选中文本回撤，阻止事件触发，生命周期钩子和调试的等)
            // 特别是getReactMountReady().enqueue()方法，添加了componentDidMount、、componentDidUpdate生命周期钩子
            // 其次通过getUpdateQueue()方法，向组件实例注入update参数，默认是ReactUpdateQueue模块。
            // 意义是未组件的setState,replaceState, forceUpdate方法完成功能提供必要的函数
  // param- context：或者为空对象，或者由上层组件提供，后者混合this.context和this.getChildContext()形成
  // 功能： 完成组件实例化，执行实例的render方法，通过ReactDomComponent绘制DomLazyTree，挂载componentDidMount函数。(初始化组件，渲染标记，注册事件监听)
  mountComponent: function(
    transaction,
    hostParent,
    hostContainerInfo,
    context
  ) {
    // 当前元素对应的上下文
    this._context = context;
    this._mountOrder = nextMountID++;
    this._hostParent = hostParent;
    this._hostContainerInfo = hostContainerInfo;

    // 获取需要添加的ReactComponentElement的props属性。
    var publicProps = this._currentElement.props;
    // 通过Component.contextTypes过滤由上层组件注入的context属性，并做校验  
    var publicContext = this._processContext(context);
    // 纯函数无状态组件，继承于PurComponent的纯函数，继承于Component的组件构造函数
    var Component = this._currentElement.type;
    // 传入组件ReactComponent的第三个参数updater。默认是ReactUpdateQueue模块，用于实现setState等方法  
    var updateQueue = transaction.getUpdateQueue();

    // 检验是否时纯组件或组件，是返回true，否则返回false
    var doConstruct = shouldConstruct(Component);
    // 初始化公共类：创建纯组件或者组件实例，或者获取无状态组件的返回值。
    var inst = this._constructComponent(
      doConstruct,
      publicProps,
      publicContext,
      updateQueue
    );
    // 待挂载的ReactComponent元素
    var renderedElement;

    // 用于判断组件是否为stateless,无状态组件没有状态更新队列，它只专注于渲染
    // 如果component是纯函数无状态组件
    if (!doConstruct && (inst == null || inst.render == null)) {
      // 无状态组件返回值即是待挂载的ReactElement 
      renderedElement = inst;
      // 校验无状态组件返回值必须是ReactElement，以及不能设置childContextTypes静态属性  
      warnIfInvalidElement(Component, renderedElement);
      // 校验无状态组件的返回值是否ReactElement
      invariant(
        inst === null ||
        inst === false ||
        React.isValidElement(inst),
        '%s(...): A valid React element (or null) must be returned. You may have ' +
        'returned undefined, an array or some other invalid object.',
        Component.displayName || Component.name || 'Component'
      );
      // 将无状态组件function(props, context, updateQueue)包装为带有render原型方法的构造函数
      inst = new StatelessComponent(Component);
      // 建状态类型设置为纯函数无状态组件
      this._compositeType = CompositeTypes.StatelessFunctional;
    } else {
      // 纯函数
      if (isPureComponent(Component)) {
        // 将状态设置为纯组件标识
        this._compositeType = CompositeTypes.PureClass;
      } else {
        // 将状态设置为组件标识
        this._compositeType = CompositeTypes.ImpureClass;
      }
    }
    // 实例没有render方法，或者props属性同publicProps不符，警告  
    if (__DEV__) {
      // This will throw later in _renderValidatedComponent, but add an early
      // warning now to help debugging
      if (inst.render == null) {
        warning(
          false,
          '%s(...): No `render` method found on the returned component ' +
          'instance: you may have forgotten to define `render`.',
          Component.displayName || Component.name || 'Component'
        );
      }

      var propsMutated = inst.props !== publicProps;
      var componentName =
        Component.displayName || Component.name || 'Component';

      warning(
        inst.props === undefined || !propsMutated,
        '%s(...): When calling super() in `%s`, make sure to pass ' +
        'up the same props that your component\'s constructor was passed.',
        componentName, componentName
      );
    }

    // These should be set up in the constructor, but as a convenience for
    // simpler class abstractions, we set them up after the fact.
    // 这些应该在构造函数中设置，但是这里再次设置了一次，保证了数据的准确性。也是为了便于进行简单的类抽象。
    inst.props = publicProps;
    inst.context = publicContext;
    inst.refs = emptyObject;
    inst.updater = updateQueue;
    // 将Component实例赋值给了_instance变量
    this._instance = inst;

    // ReactInstanceMap中添加组件实例 。ReactInstanceMap存放这所有的挂载元素。将实例存储为一个引用
    ReactInstanceMap.set(inst, this);

    if (__DEV__) {
      // Since plain JS classes are defined without any special initialization
      // logic, we can not catch common errors early. Therefore, we have to
      // catch them here, at initialization time, instead.
      // 组件不是由ReactClass方式创建，且添加了getInitialState或getDefaultProps方法，警告  
      warning(
        !inst.getInitialState ||
        inst.getInitialState.isReactClassApproved ||
        inst.state,
        'getInitialState was defined on %s, a plain JavaScript class. ' +
        'This is only supported for classes created using React.createClass. ' +
        'Did you mean to define a state property instead?',
        this.getName() || 'a component'
      );
      warning(
        !inst.getDefaultProps ||
        inst.getDefaultProps.isReactClassApproved,
        'getDefaultProps was defined on %s, a plain JavaScript class. ' +
        'This is only supported for classes created using React.createClass. ' +
        'Use a static property to define defaultProps instead.',
        this.getName() || 'a component'
      );
      // 静态属性propTypes、contextTypes书写为原型属性提示，只构造函数拥有，实例没有 
      warning(
        !inst.propTypes,
        'propTypes was defined as an instance property on %s. Use a static ' +
        'property to define propTypes instead.',
        this.getName() || 'a component'
      );
      warning(
        !inst.contextTypes,
        'contextTypes was defined as an instance property on %s. Use a ' +
        'static property to define contextTypes instead.',
        this.getName() || 'a component'
      );
      // 接口变动更改 
      warning(
        typeof inst.componentShouldUpdate !== 'function',
        '%s has a method called ' +
        'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' +
        'The name is phrased as a question because the function is ' +
        'expected to return a value.',
        (this.getName() || 'A component')
      );
      warning(
        typeof inst.componentDidUnmount !== 'function',
        '%s has a method called ' +
        'componentDidUnmount(). But there is no such lifecycle method. ' +
        'Did you mean componentWillUnmount()?',
        this.getName() || 'A component'
      );
      warning(
        typeof inst.componentWillRecieveProps !== 'function',
        '%s has a method called ' +
        'componentWillRecieveProps(). Did you mean componentWillReceiveProps()?',
        (this.getName() || 'A component')
      );
    }
    // 初始化state,并提示state那个设置对象形式
    var initialState = inst.state;
    if (initialState === undefined) {
      inst.state = initialState = null;
    }
    invariant(
      typeof initialState === 'object' && !Array.isArray(initialState),
      '%s.state: must be set to an object or null',
      this.getName() || 'ReactCompositeComponent'
    );
    // state更新，强制更新的标识
    this._pendingStateQueue = null;
    this._pendingReplaceState = false;
    this._pendingForceUpdate = false;
    // 执行实力inst的render方法，嵌套调用mountComponent.将返回值ReactNode元素转为DomLazyTree输出
    var markup;
    // 如果挂载时出错
    if (inst.unstable_handleError) {
      markup = this.performInitialMountWithErrorHandling(
        renderedElement,
        hostParent,
        hostContainerInfo,
        transaction,
        context
      );
    } else {
      // 执行初始挂载
      markup = this.performInitialMount(renderedElement, hostParent, hostContainerInfo, transaction, context);
    }
    // 向后置钩子transaction.getReactMountReady()中添加实例的生命周期方法componentDidMount
    if (inst.componentDidMount) {
      if (__DEV__) {
        transaction.getReactMountReady().enqueue(() => {
          measureLifeCyclePerf(
            () => inst.componentDidMount(),
            this._debugID,
            'componentDidMount'
          );
        });
      } else {
        transaction.getReactMountReady().enqueue(inst.componentDidMount, inst); // 第一次参数是方法，第二个参数时scope
      }
    }

    return markup;
  },
  // 创建纯组件或组件实例。或者返回无状态组件的返回值。
  _constructComponent: function(
    doConstruct,
    publicProps,
    publicContext,
    updateQueue
  ) {
    if (__DEV__) {
      ReactCurrentOwner.current = this;
      try {
        return this._constructComponentWithoutOwner(
          doConstruct,
          publicProps,
          publicContext,
          updateQueue
        );
      } finally {
        ReactCurrentOwner.current = null;
      }
    } else {
      // 创建纯组件或组件实例，或者获取无状态组件的返回值 
      return this._constructComponentWithoutOwner(
        doConstruct,
        publicProps,
        publicContext,
        updateQueue
      );
    }
  },
  // 创建纯组件或组件实例，或者获取无状态组件的返回值 
  _constructComponentWithoutOwner: function(
    doConstruct,
    publicProps,
    publicContext,
    updateQueue
  ) {
    // 获取组件的构造函数或类
    var Component = this._currentElement.type;
    // doConstruct： Component为纯组件或组件，创建实例；Component可能为TopLevelWrapper 
    if (doConstruct) {
      if (__DEV__) {
        return measureLifeCyclePerf(
          () => new Component(publicProps, publicContext, updateQueue),
          this._debugID,
          'ctor'
        );
      } else {
        return new Component(publicProps, publicContext, updateQueue);
      }
    }

    
    // Component为工厂函数ReactClassFacory=function(props,context,updateQueue){  
    //     return new ReactClass(props,context,updateQueue)     
    // }  
    // 或者，无状态组件纯函数形式function(props,context,updateQueue){}
    if (__DEV__) {
      return measureLifeCyclePerf(
        () => Component(publicProps, publicContext, updateQueue),
        this._debugID,
        'render'
      );
    } else {
      return Component(publicProps, publicContext, updateQueue);
    }
  },

  performInitialMountWithErrorHandling: function(
    renderedElement,
    hostParent,
    hostContainerInfo,
    transaction,
    context
  ) {
    var markup;
    var checkpoint = transaction.checkpoint();
    // 捕捉出错，如果没有则执行初始挂载
    try {
      markup = this.performInitialMount(renderedElement, hostParent, hostContainerInfo, transaction, context);
    } catch (e) {
      // Roll back to checkpoint, handle error (which may add items to the transaction), and take a new checkpoint
      transaction.rollback(checkpoint);
      this._instance.unstable_handleError(e);
      if (this._pendingStateQueue) {
        // _processPendingState方法获取组件setState、replaceState方法执行后的最终state  
        this._instance.state = this._processPendingState(this._instance.props, this._instance.context);
      }
      checkpoint = transaction.checkpoint();
      // 如果捕捉到错误，执行unmountComponent后，再初始化挂载
      this._renderedComponent.unmountComponent(true);
      transaction.rollback(checkpoint);

      // Try again - we've informed the component about the error, so they can render an error message this time.
      // If this throws again, the error will bubble up (and can be caught by a higher error boundary).
      markup = this.performInitialMount(renderedElement, hostParent, hostContainerInfo, transaction, context);
    }
    return markup;
  },
  // 执行ReactComponent实例的render方法，获取其返回值ReactNode
  // 嵌套调用mountComponent,完成ReactNode元素相应组件的实例化和render方法的执行
  // 最终通过ReactElement转化为DOMLazyTree对象输出，其node属性时需要插入文档的DOM对象
  performInitialMount: function(renderedElement, hostParent, hostContainerInfo, transaction, context) {
    // 获取创建的ReactComponent实例
    var inst = this._instance;

    var debugID = 0;
    if (__DEV__) {
      debugID = this._debugID;
    }
    // 执行组件实例的componentWillMount
    // componentWillMount方法内调用setState、replaceState，_pendingStateQueue有值，刷新state后再行绘制
    if (inst.componentWillMount) {
      if (__DEV__) {
        measureLifeCyclePerf(
          () => inst.componentWillMount(),
          debugID,
          'componentWillMount'
        );
      } else {
        inst.componentWillMount();
      }
      console.log('componentWillMount, componentWillMount');
      // When mounting, calls to `setState` by `componentWillMount` will set
      // `this._pendingStateQueue` without triggering a re-render.
      if (this._pendingStateQueue) {
        // _processPendingState方法获取组件setState、replaceState方法执行后的最终state  
        inst.state = this._processPendingState(inst.props, inst.context);
      }
      console.log('inst.state', inst.state);
    }

    // If not a stateless component, we now render
    // 下面的操作：间接执行ReactClass或TopLevelWrapper实例的render方法，获取待挂载的元素ReactNode  
    // 组件若为函数式无状态组件function(props,context,updateQueue){}，renderedElement由传参提供
    if (renderedElement === undefined) {
      renderedElement = this._renderValidatedComponent();
    }

     // 节点类型，ReactComponentElement元素返回1；ReactDomElement元素返回0；若为空，返回2
    var nodeType = ReactNodeTypes.getType(renderedElement);
    this._renderedNodeType = nodeType;
    // 调用instantiateReactComponent模块以实例化render方法的返回值，即renderedElement元素  
    var child = this._instantiateReactComponent(
      renderedElement,
      nodeType !== ReactNodeTypes.EMPTY /* shouldHaveDebugID */
    );
    // render方法内子组件实例 
    this._renderedComponent = child;
    console.log('child', child);
    debugger;
    // 嵌套调用mountComponent，完成renderedElement元素相应组件的实例化及render方法执行  
    // 最终通过ReactDomElement转化为DOMLazyTree对象输出，其node属性为需要插入文档dom对象  
    var markup = ReactReconciler.mountComponent(
      child,
      transaction,
      hostParent,
      hostContainerInfo,
      this._processChildContext(context),
      debugID
    );

    if (__DEV__) {
      if (debugID !== 0) {
        var childDebugIDs = child._debugID !== 0 ? [child._debugID] : [];
        ReactInstrumentation.debugTool.onSetChildren(debugID, childDebugIDs);
      }
    }

    return markup;
  },
  // 由render方法内子组件实例，通过ReactDomComponent等，获取相应的dom节点
  getHostNode: function() {
    return ReactReconciler.getHostNode(this._renderedComponent);
  },

  /**
   * Releases any resources allocated by `mountComponent`.
   *
   * @final
   * @internal
   */
  // 移除组件，执行componentWillUnmount方法  
  unmountComponent: function(safely) {
    if (!this._renderedComponent) {
      return;
    }

    var inst = this._instance;
    // componentWillUnmount存在，则调用
    if (inst.componentWillUnmount && !inst._calledComponentWillUnmount) {
      inst._calledComponentWillUnmount = true;

      if (safely) {
        var name = this.getName() + '.componentWillUnmount()';
        ReactErrorUtils.invokeGuardedCallback(name, inst.componentWillUnmount.bind(inst));
      } else {
        if (__DEV__) {
          measureLifeCyclePerf(
            () => inst.componentWillUnmount(),
            this._debugID,
            'componentWillUnmount'
          );
        } else {
          inst.componentWillUnmount();
        }
      }
    }
    // 如果组件已经渲染，则对组件进行 unmountComponent 操作
    if (this._renderedComponent) {
      ReactReconciler.unmountComponent(this._renderedComponent, safely);
      this._renderedNodeType = null;
      this._renderedComponent = null;
      this._instance = null;
    }

    // Reset pending fields
    // Even if this component is scheduled for another update in ReactUpdates,
    // it would still be ignored because these fields are reset.
    // 重置相关参数、更新队列以及更新状态
    this._pendingStateQueue = null;
    this._pendingReplaceState = false;
    this._pendingForceUpdate = false;
    this._pendingCallbacks = null;
    this._pendingElement = null;

    // These fields do not really need to be reset since this object is no
    // longer accessible.
    this._context = null;
    this._rootNodeID = 0;
    this._topLevelWrapper = null;

    // Delete the reference from the instance to this internal representation
    // which allow the internals to be properly cleaned up even if the user
    // leaks a reference to the public instance.
    // 清除公共类
    ReactInstanceMap.remove(inst);

    // Some existing components rely on inst.props even after they've been
    // destroyed (in event handlers).
    // TODO: inst.props = null;
    // TODO: inst.state = null;
    // TODO: inst.context = null;
  },

  /**
   * Filters the context object to only contain keys specified in
   * `contextTypes`
   *
   * @param {object} context
   * @return {?object}
   * @private
   */
  // 通过Component.contextTypes过滤由上层组件注入的context属性，仅保留Component.contextTypes约定的
  _maskContext: function(context) {
    var Component = this._currentElement.type;
    var contextTypes = Component.contextTypes;
    if (!contextTypes) {
      return emptyObject;
    }
    var maskedContext = {};
    for (var contextName in contextTypes) {
      maskedContext[contextName] = context[contextName];
    }
    return maskedContext;
  },

  /**
   * Filters the context object to only contain keys specified in
   * `contextTypes`, and asserts that they are valid.
   *
   * @param {object} context
   * @return {?object}
   * @private
   */
   // 通过Component.contextTypes过滤由上层组件注入的context属性，并做校验
  _processContext: function(context) {
    var maskedContext = this._maskContext(context);
    if (__DEV__) {
      var Component = this._currentElement.type;
      if (Component.contextTypes) {
        this._checkContextTypes(
          Component.contextTypes,
          maskedContext,
          'context'
        );
      }
    }
    return maskedContext;
  },

  /**
   * @param {object} currentContext
   * @return {object}
   * @private
   */
  // 将当前组件的Context注入子组件；执行getChildContext方法并作校验，注入子组件的context中  
  _processChildContext: function(currentContext) {
    var Component = this._currentElement.type;
    var inst = this._instance;
    var childContext;

    if (inst.getChildContext) {
      if (__DEV__) {
        ReactInstrumentation.debugTool.onBeginProcessingChildContext();
        try {
          childContext = inst.getChildContext();
        } finally {
          ReactInstrumentation.debugTool.onEndProcessingChildContext();
        }
      } else {
        childContext = inst.getChildContext();
      }
    }

    if (childContext) {
      invariant(
        typeof Component.childContextTypes === 'object',
        '%s.getChildContext(): childContextTypes must be defined in order to ' +
        'use getChildContext().',
        this.getName() || 'ReactCompositeComponent'
      );
      if (__DEV__) {
        this._checkContextTypes(
          Component.childContextTypes,
          childContext,
          'childContext'
        );
      }
      for (var name in childContext) {
        invariant(
          name in Component.childContextTypes,
          '%s.getChildContext(): key "%s" is not defined in childContextTypes.',
          this.getName() || 'ReactCompositeComponent',
          name
        );
      }
      return Object.assign({}, currentContext, childContext);
    }
    return currentContext;
  },

  /**
   * Assert that the context types are valid
   *
   * @param {object} typeSpecs Map of context field to a ReactPropType
   * @param {object} values Runtime values that need to be type-checked
   * @param {string} location e.g. "prop", "context", "child context"
   * @private
   */
  // 校验context 
  _checkContextTypes: function(
    typeSpecs,
    values,
    location: ReactPropTypeLocations,
  ) {
    if (__DEV__) {
      checkReactTypeSpec(
        typeSpecs,
        values,
        location,
        this.getName(),
        null,
        this._debugID
      );
    }
  },
  // 接收新的组件带渲染元素nextElement,以替换旧组件元素this._currentElement
  // 通过performUpdateIfNecessary方法调用，nextElement由this._pendingElement提供
  // 该方法触发执行的实际情形是ReactDom.render(ReactNode, pNode)挂在的组件元素，其父节点pNode由React方式绘制
  // 通过_updateRenderdComponent方法调用，nextElement为待变更的子组件元素
  receiveComponent: function(nextElement, transaction, nextContext) {
    var prevElement = this._currentElement;
    var prevContext = this._context;

    this._pendingElement = null;

    this.updateComponent(
      transaction,
      prevElement,
      nextElement,
      prevContext,
      nextContext
    );
  },

  /**
   * If any of `_pendingElement`, `_pendingStateQueue`, or `_pendingForceUpdate`
   * is set, update the component.
   *
   * @param {ReactReconcileTransaction} transaction
   * @internal
   */
  // 由ReactDom.render(ReactNode,pNode)方法插入文档时，pNode由react方式绘制  
  // 调用ReactReconciler.receiveComponent间接执行updateComponent方法重绘组件  
  // 组件的setState、replaceState、forceUpdate方法触发重绘，直接调用updateComponent方法重绘组件
  performUpdateIfNecessary: function(transaction) {
    // ReactDom.render方法渲染时包裹元素由react组件渲染，将待渲染的元素推入_penddingElement中
    if (this._pendingElement != null) {
      ReactReconciler.receiveComponent(
        this,
        this._pendingElement,
        transaction,
        this._context
      );

      // 通过调用组件的setState、replaceState、forceUpdate方法重绘组件
    } else if (this._pendingStateQueue !== null || this._pendingForceUpdate) {
      this.updateComponent(
        transaction,
        this._currentElement,
        this._currentElement,
        this._context,
        this._context
      );
    } else {
      this._updateBatchNumber = null;
    }
  },

  /**
   * Perform an update to a mounted component. The componentWillReceiveProps and
   * shouldComponentUpdate methods are called, then (assuming the update isn't
   * skipped) the remaining update lifecycle methods are called and the DOM
   * representation is updated.
   *
   * By default, this implements React's rendering and reconciliation algorithm.
   * Sophisticated clients may wish to override this.
   *
   * @param {ReactReconcileTransaction} transaction
   * @param {ReactElement} prevParentElement
   * @param {ReactElement} nextParentElement
   * @internal
   * @overridable
   */
  // 判断props变更情况，执行shouldComponentUpdate方法，重绘组件或者更改组件的属性  
  // 参数transaction，组件重绘时用于向子组件提供updater参数，setState等方法可用；以及实现componentWillMount挂载功能  
  // 参数prevParentElement变更前的组件元素ReactNode，nextParentElement变更后的组件元素，作为render方法渲染节点的父元素  
  // 参数prevUnmaskedContext更迭前的context，nextUnmaskedContext更迭后的context  
  updateComponent: function(
    transaction,
    prevParentElement,
    nextParentElement,
    prevUnmaskedContext,
    nextUnmaskedContext
  ) {
    var inst = this._instance;
    // 组件实例尚未生成，报错
    invariant(
      inst != null,
      'Attempted to update component `%s` that has already been unmounted ' +
      '(or failed to mount).',
      this.getName() || 'ReactCompositeComponent'
    );

    var willReceive = false;
    var nextContext;

    // Determine if the context has changed or not
    // 上下文是否改变了
    if (this._context === nextUnmaskedContext) {
      nextContext = inst.context;
    } else {
      nextContext = this._processContext(nextUnmaskedContext);
      willReceive = true;
    }

    var prevProps = prevParentElement.props;
    var nextProps = nextParentElement.props;

    // Not a simple state update but a props update
    // 包含仅待渲染元素的props变更 
    if (prevParentElement !== nextParentElement) {
      willReceive = true;
    }

    // An update here will schedule an update but immediately set
    // _pendingStateQueue which will ensure that any state updates gets
    // immediately reconciled instead of waiting for the next batch.
    // 更新context、或变更带渲染组件元素或其props时willReceive赋值为真，由父组件发起，调用componentWillReceiveProps方法  
    if (willReceive && inst.componentWillReceiveProps) {
      if (__DEV__) {
        measureLifeCyclePerf(
          () => inst.componentWillReceiveProps(nextProps, nextContext),
          this._debugID,
          'componentWillReceiveProps',
        );
      } else {
        inst.componentWillReceiveProps(nextProps, nextContext);
      }
    }
    // _processPendingState方法获取组件setState、replaceState方法执行后的最终state  
    // 将新的state合并到更新队列中，此时nextState为最新的state
    var nextState = this._processPendingState(nextProps, nextContext);
    var shouldUpdate = true;
    // 调用组件的shouldComponentUpdate判断是否需要重绘  
    // 纯组件不能设置shouldComponentUpdate方法，仅判断props、state是否变更  
    if (!this._pendingForceUpdate) {
      // 如果shouldComponentUpdate存在则调用
      if (inst.shouldComponentUpdate) {
        if (__DEV__) {
          shouldUpdate = measureLifeCyclePerf(
            () => inst.shouldComponentUpdate(nextProps, nextState, nextContext),
            this._debugID,
            'shouldComponentUpdate'
          );
        } else {
          shouldUpdate = inst.shouldComponentUpdate(nextProps, nextState, nextContext);
        }
      } else {
        if (this._compositeType === CompositeTypes.PureClass) {
          shouldUpdate =
            !shallowEqual(prevProps, nextProps) ||
            !shallowEqual(inst.state, nextState);
        }
      }
    }
    // shouldComponentUpdate方法返回undefined，警告 
    if (__DEV__) {
      warning(
        shouldUpdate !== undefined,
        '%s.shouldComponentUpdate(): Returned undefined instead of a ' +
        'boolean value. Make sure to return true or false.',
        this.getName() || 'ReactCompositeComponent'
      );
    }

    this._updateBatchNumber = null;
    // 重绘组件  
    if (shouldUpdate) {
      // 重置更新队列
      this._pendingForceUpdate = false;
      // Will set `this.props`, `this.state` and `this.context`.
      // 执行componentWillUpdate方法，重绘组件实例render方法内待渲染的子组件，挂载componentDidUpdate方法  
      // 即将更新this.state, this.props 和this.content
      this._performComponentUpdate(
        nextParentElement,
        nextProps,
        nextState,
        nextContext,
        transaction,
        nextUnmaskedContext
      );
    } else {
      // 如果确定组件不更新，任然需要设置props和state
      // 只变更组件的部分属性，不开启重绘功能
      this._currentElement = nextParentElement;
      this._context = nextUnmaskedContext;
      inst.props = nextProps;
      inst.state = nextState;
      inst.context = nextContext;
    }
  },
  // 获取组件setState、replaceState方法执行后的最终state  
  // setState、replaceState方法执行后更迭的state以函数或state数据形式推入_pendingStateQueue中  
  _processPendingState: function(props, context) {
    var inst = this._instance;
    var queue = this._pendingStateQueue; // 组件调用setState、replaceState方法，通过ReactUpdateQueue将更迭后的state推入state数据
    var replace = this._pendingReplaceState; // 判断组件是否通过replaceState方法向_pendingStateQueue推入数据

    this._pendingReplaceState = false;
    this._pendingStateQueue = null;

    if (!queue) {
      return inst.state;
    }

    if (replace && queue.length === 1) {
      return queue[0];
    }

    var nextState = Object.assign({}, replace ? queue[0] : inst.state);
    for (var i = replace ? 1 : 0; i < queue.length; i++) {
      var partial = queue[i];
      Object.assign(
        nextState,
        typeof partial === 'function' ?
          partial.call(inst, nextState, props, context) :
          partial
      );
    }

    return nextState;
  },

  /**
   * Merges new props and state, notifies delegate methods of update and
   * performs update.
   *
   * @param {ReactElement} nextElement Next element
   * @param {object} nextProps Next public object to set as properties.
   * @param {?object} nextState Next object to set as state.
   * @param {?object} nextContext Next public object to set as context.
   * @param {ReactReconcileTransaction} transaction
   * @param {?object} unmaskedContext
   * @private
   */
  // 执行componentWillUpdate方法，重绘组件实例render方法内待渲染的子组件，挂载componentDidUpdate方法  
  // 当组件确认需要更新时调用
  _performComponentUpdate: function(
    nextElement,
    nextProps,
    nextState,
    nextContext,
    transaction,
    unmaskedContext
  ) {
    var inst = this._instance;
    // 如果存在componentDidUpdate,则将当前的props,statem context保存一份
    var hasComponentDidUpdate = Boolean(inst.componentDidUpdate);
    var prevProps;
    var prevState;
    var prevContext;
    if (hasComponentDidUpdate) {
      prevProps = inst.props;
      prevState = inst.state;
      prevContext = inst.context;
    }
    //componentWillUpdate存在则执行componentWillUpdate方法
    if (inst.componentWillUpdate) {
      if (__DEV__) {
        measureLifeCyclePerf(
          () => inst.componentWillUpdate(nextProps, nextState, nextContext),
          this._debugID,
          'componentWillUpdate'
        );
      } else {
        inst.componentWillUpdate(nextProps, nextState, nextContext);
      }
    }

    this._currentElement = nextElement;
    this._context = unmaskedContext;
    // 更新this.props, this.state 和this.context
    inst.props = nextProps;
    inst.state = nextState;
    inst.context = nextContext;
  // 以更新子组件的方式或重新创建子组件的方式重调用render渲染组件
    this._updateRenderedComponent(transaction, unmaskedContext);
    // 当组件完成更新后，如果存在componentDidUpdate则调用
    if (hasComponentDidUpdate) {
      if (__DEV__) {
        transaction.getReactMountReady().enqueue(() => {
          measureLifeCyclePerf(
            inst.componentDidUpdate.bind(inst, prevProps, prevState, prevContext),
            this._debugID,
            'componentDidUpdate'
          );
        });
      } else {
        transaction.getReactMountReady().enqueue(
          inst.componentDidUpdate.bind(inst, prevProps, prevState, prevContext),
          inst
        );
      }
    }
  },

  /**
   * Call the component's `render` method and update the DOM accordingly.
   *
   * @param {ReactReconcileTransaction} transaction
   * @internal
   */
   // 以更新子组件的方式或重新创建子组件的方式重绘render方法待渲染的子组件  
  _updateRenderedComponent: function(transaction, context) {
    var prevComponentInstance = this._renderedComponent;// 组件render待渲染的子组件实例
    var prevRenderedElement = prevComponentInstance._currentElement;// 子组件元素  
    // _renderValidatedComponent方法调用组件实例inst的render方法，获取待挂载的元素  
    var nextRenderedElement = this._renderValidatedComponent();

    var debugID = 0;
    if (__DEV__) {
      debugID = this._debugID;
    }
    // shouldUpdateReactComponent方法返回真值，更新组件实例；返回否值，销毁实例后、重新创建实例  
    // 组件元素的构造函数或key值不同，销毁实例后再行创建  
    
    //如果需要更新 render方法子组件构造函数及key相同，则通过ReactReconciler.receiveComponent方法更新子组件实例  
    if (shouldUpdateReactComponent(prevRenderedElement, nextRenderedElement)) {
      ReactReconciler.receiveComponent(
        prevComponentInstance,
        nextRenderedElement,
        transaction,
        this._processChildContext(context)
      );

    } else {
      // 如果不需要更新则渲染组件
      var oldHostNode = ReactReconciler.getHostNode(prevComponentInstance);
      ReactReconciler.unmountComponent(prevComponentInstance, false);

      var nodeType = ReactNodeTypes.getType(nextRenderedElement);
      this._renderedNodeType = nodeType;
      // 得到nextRenderedElement对应的component类实例
      var child = this._instantiateReactComponent(
        nextRenderedElement,
        nodeType !== ReactNodeTypes.EMPTY /* shouldHaveDebugID */
      );
      this._renderedComponent = child;
      // 使用render递归渲染
      var nextMarkup = ReactReconciler.mountComponent(
        child,
        transaction,
        this._hostParent,
        this._hostContainerInfo,
        this._processChildContext(context),
        debugID
      );

      if (__DEV__) {
        if (debugID !== 0) {
          var childDebugIDs = child._debugID !== 0 ? [child._debugID] : [];
          ReactInstrumentation.debugTool.onSetChildren(debugID, childDebugIDs);
        }
      }
      // 替换文档中挂载的Dom元素DomLazyTree
      this._replaceNodeWithMarkup(
        oldHostNode,
        nextMarkup,
        prevComponentInstance
      );
    }
  },

  /**
   * Overridden in shallow rendering.
   *
   * @protected
   */
  // 替换文档中挂载的Dom元素DomLazyTree  
  _replaceNodeWithMarkup: function(oldHostNode, nextMarkup, prevInstance) {
    ReactComponentEnvironment.replaceNodeWithMarkup(
      oldHostNode,
      nextMarkup,
      prevInstance
    );
  },

  // 调用组件实例inst的render方法，获取待挂载的元素  
  _renderValidatedComponentWithoutOwnerOrContext: function() {
    var inst = this._instance;
    var renderedElement;

    if (__DEV__) {
      renderedElement = measureLifeCyclePerf(
        () => inst.render(),
        this._debugID,
        'render'
      );
    } else {
      renderedElement = inst.render();
    }

    if (__DEV__) {
      // We allow auto-mocks to proceed as if they're returning null.
      if (renderedElement === undefined &&
          inst.render._isMockFunction) {
        // This is probably bad practice. Consider warning here and
        // deprecating this convenience.
        renderedElement = null;
      }
    }

    return renderedElement;
  },

  // 调用组件实例inst的render方法，获取待挂载的元素  
  _renderValidatedComponent: function() {
    var renderedElement;
    if (__DEV__ || this._compositeType !== CompositeTypes.StatelessFunctional) {
      ReactCurrentOwner.current = this;
      try {
        renderedElement =
          this._renderValidatedComponentWithoutOwnerOrContext();
      } finally {
        ReactCurrentOwner.current = null;
      }
    } else {
      renderedElement =
        this._renderValidatedComponentWithoutOwnerOrContext();
    }
    // 校验renderedElement是否为ReactElement
    invariant(
      // TODO: An `isValidNode` function would probably be more appropriate
      renderedElement === null || renderedElement === false ||
      React.isValidElement(renderedElement),
      '%s.render(): A valid React element (or null) must be returned. You may have ' +
        'returned undefined, an array or some other invalid object.',
      this.getName() || 'ReactCompositeComponent'
    );

    return renderedElement;
  },

  /**
   * Lazily allocates the refs object and stores `component` as `ref`.
   *
   * @param {string} ref Reference name.
   * @param {component} component Component to store as `ref`.
   * @final
   * @private
   */
  // 对外提供接口，用于向组件实例ReactComponentInstance添加this.refs属性
  attachRef: function(ref, component) {// 参数component为子组件  
    var inst = this.getPublicInstance();
    // 无状态组件没有this.refs属性  
    invariant(inst != null, 'Stateless function components cannot have refs.');
    var publicComponentInstance = component.getPublicInstance();
     // 无状态子组件也不能作为上层组件的this.refs的值
    if (__DEV__) {
      var componentName = component && component.getName ?
        component.getName() : 'a component';
      warning(
        publicComponentInstance != null ||
        component._compositeType !== CompositeTypes.StatelessFunctional,
        'Stateless function components cannot be given refs ' +
        '(See ref "%s" in %s created by %s). ' +
        'Attempts to access this ref will fail.',
        ref,
        componentName,
        this.getName()
      );
    }
    // 通过引用对象的形式赋值inst.refs
    var refs = inst.refs === emptyObject ? (inst.refs = {}) : inst.refs;
    refs[ref] = publicComponentInstance;
  },

  /**
   * Detaches a reference name.
   *
   * @param {string} ref Name to dereference.
   * @final
   * @private
   */
  // 销毁组件实例ReactComponentInstance的refs属性
  detachRef: function(ref) {
    var refs = this.getPublicInstance().refs;
    delete refs[ref];
  },

  /**
   * Get a text description of the component that can be used to identify it
   * in error messages.
   * @return {string} The name or null.
   * @internal
   */
  getName: function() {
    var type = this._currentElement.type;
    var constructor = this._instance && this._instance.constructor;
    return (
      type.displayName || (constructor && constructor.displayName) ||
      type.name || (constructor && constructor.name) ||
      null
    );
  },

  /**
   * Get the publicly accessible representation of this component - i.e. what
   * is exposed by refs and returned by render. Can be null for stateless
   * components.
   *
   * @return {ReactComponent} the public component instance.
   * @internal
   */
  // 获取组件ReactComponent的实例
  getPublicInstance: function() {
    var inst = this._instance;
    if (this._compositeType === CompositeTypes.StatelessFunctional) {
      return null;
    }
    return inst;
  },

  // Stub
  // 调用instantiateReactComponent模块，用于创建子组件
  _instantiateReactComponent: null,

};

module.exports = ReactCompositeComponent;
