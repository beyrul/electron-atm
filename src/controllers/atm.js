const StatesService = require('../services/states.js');
const ScreensService = require('../services/screens.js');
const FITsService = require('../services/fits.js');
const Trace = require('../controllers/trace.js');

function ATM(settings, log) {
  /**
   * [replySolicitedStatus description]
   * @param  {[type]} status [description]
   * @return {[type]}        [description]
   */
  this.replySolicitedStatus = function(status){
    var reply = {};
    reply.message_class = 'Solicited';
    reply.message_subclass = 'Status'; 

    switch(status){
      case 'Ready':
      case 'Command Reject':
      case 'Specific Command Reject':
        reply.status_descriptor = status;
        break;
      default:
        log.info('atm.replySolicitedStatus(): unknown status ' + status);
        reply.status_descriptor = 'Command Reject';
    }
    return reply;
  };

  /**
   * [processTerminalCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processTerminalCommand = function(data){
    switch(data.command_code){
      case 'Go out-of-service':
        this.status = 'Out-Of-Service';
        break;
      case 'Go in-service':
        this.status = 'In-Service';
        //this.processState('000');
        break;
      default:
          log.info('atm.processTerminalCommand(): unknown command code: ' + data.command_code);
          return this.replySolicitedStatus('Command Reject');
        }
      return this.replySolicitedStatus('Ready');
  } 

  /**
   * [processCustomizationCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processCustomizationCommand = function(data){
    switch(data.message_identifier){
      case 'Screen Data load':
        if(this.screens.add(data.screens))
          return this.replySolicitedStatus('Ready') 
        else
          return this.replySolicitedStatus('Command Reject');

      case 'State Tables load':
        if(this.states.add(data.states))
          return this.replySolicitedStatus('Ready') 
        else
          return this.replySolicitedStatus('Command Reject');

      case 'FIT Data load':
        if(this.FITs.add(data.FITs))
          return this.replySolicitedStatus('Ready')
        else
          return this.replySolicitedStatus('Command Reject');

      case 'Configuration ID number load':
        if(data.config_id){
          this.config_id = data.config_id;
          return this.replySolicitedStatus('Ready');
        }else{
          log.info('ATM.processDataCommand(): wrong Config ID');
          return this.replySolicitedStatus('Command Reject');
        }
        break;

      default:
        log.info('ATM.processDataCommand(): unknown message identifier: ', data.message_identifier);
        return this.replySolicitedStatus('Command Reject');
    }
    return this.replySolicitedStatus('Command Reject');
  };

  /**
   * [processDataCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processDataCommand = function(data){
    switch(data.message_subclass){
      case 'Customization Command':
        return this.processCustomizationCommand(data);

      case 'Interactive Transaction Response':
        return this.processInteractiveTransactionResponse(data);
        
      default:
        log.info('atm.processDataCommand(): unknown message sublass: ', data.message_subclass);
        return this.replySolicitedStatus('Command Reject');
    }
    return this.replySolicitedStatus('Command Reject');
  }

  /**
   * [processTransactionReply description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processTransactionReply = function(data){
    // TODO: processing next_state
    return this.replySolicitedStatus('Ready');
  };


  /**
   * [initBuffers clears the terminal buffers
   * When the terminal enters the Card Read State, the following buffers are initialized:
   *  - Card data buffers (no data)
   *  - PIN and General Purpose buffers (no data)
   *  - Amount buffer (zero filled)
   *  - Operation code buffer (space filled)
   *  - FDK buffer (zero filled)]
   * @return {[type]} [description]
   */
  this.initBuffers = function(){
    this.PIN_buffer = '';
    this.buffer_B = null;
    this.buffer_C = null;
    this.amount_buffer = '000000000000';
    this.opcode_buffer = '        ';
    this.FDK_buffer = '0000000000000';

    return true;
  }

  /**
   * [setScreen description]
   * @param {[type]} screen_number [description]
   */
  this.setScreen = function(screen_number){
    this.current_screen = this.screens.get(screen_number)
    if(this.current_screen){
      log.info(trace.object(this.current_screen));
    } else {
      log.error('atm.setScreen(): unable to find screen ' + screen_number);
    }
  }

  /**
   * [processStateA process the Card Read state]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateA = function(state){
    this.initBuffers();
    this.setScreen(state.screen_number)

    return state.good_read_next_state;
  }

  this.processStateB = function(state){
    this.setScreen(state.screen_number)
    this.max_pin_length = this.FITs.getMaxPINLength(this.card.number)

    if(this.PIN_buffer.length > 3){
      // TODO: PIN encryption 
      return state.remote_pin_check_next_screen
    }
  }

  /**
   * [setOpCodeBufferValueAt set this.opcode_buffer[position] with the value ]
   * @param {[type]} position [description]
   * @param {[type]} value    [description]
   */
  this.setOpCodeBufferValueAt = function(position, value){
    this.opcode_buffer = this.opcode_buffer.substr(0, position) + value + this.opcode_buffer.substr(position + 1)
  }

  /**
   * [setOpCodeBuffer process the D state logic (Pre‐Set Operation Code Buffer)]
   * @param {[state]} state [D-type state]
   * @param {[extension_state]} state [Z-type state]
   */
  this.setOpCodeBuffer = function(state, extension_state){
    /**
     * Specifies bytes of Operation Code buffer to be cleared to graphic ‘space’. Each bit relates to a byte
     * in the Operation Code buffer. If a bit is zero, the corresponding entry is cleared. If a bit is one, the
     * corresponding entry is unchanged. 
     */
    var mask = state.clear_mask;
    for(var bit = 0; bit < 8; bit++){
      if((mask & Math.pow(2, bit)).toString() === '0')
        this.setOpCodeBufferValueAt(bit, ' ');
    }

    /**
     * The buffer contains eight bytes. This entry sets the specified bytes to one of the values from keys[]. If a bit is one, the
     * corresponding entry is set to keys[i]. If a bit is zero, the corresponding entry is unchanged.
     */
    var keys = ['A', 'B', 'C', 'D'];
    ['A_preset_mask',
     'B_preset_mask',
     'C_preset_mask',
     'D_preset_mask'
     ].forEach( (element, i) => {
        mask = state[element];
        for(var bit = 0; bit < 8; bit++){
          if((mask & Math.pow(2, bit)).toString() === Math.pow(2, bit).toString())
            this.setOpCodeBufferValueAt(bit, keys[i]);
        }
     });

    if(extension_state && extension_state.entries){
      var keys = ['F', 'G', 'H', 'I'];
      for(var i = 0; i < 4; i++){
        mask = extension_state.entries[i];
        for(var bit = 0; bit < 8; bit++){
          if((mask & Math.pow(2, bit)).toString() === Math.pow(2, bit).toString())
            this.setOpCodeBufferValueAt(bit, keys[i]);
        }
       };
    }

    return true;
  }

  /**
   * [processStateD description]
   * @param  {[type]} state           [description]
   * @param  {[type]} extension_state [description]
   * @return {[type]}                 [description]
   */
  this.processStateD = function(state, extension_state){
    this.setOpCodeBuffer(state, extension_state);
    log.info('Operation code buffer set to \'' + this.opcode_buffer + '\'');
    return state.next_state;
  }

  /**
   * [processStateK description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateK = function(state){
    var institution_id = this.FITs.getInstitutionByCardnumber(this.card.number)
    // log.info('Found institution_id ' + institution_id);
    return state.states[parseInt(institution_id)];
  }

  this.processStateW = function(state){
    return state.states[this.FDK_buffer]
  }

  this.processStateX = function(state){
    this.setScreen(state.screen_number);
  }

  /**
   * [processStateY description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateY = function(state){
    this.setScreen(state.screen_number);
    this.current_state = state;

    var button = this.buttons_pressed.shift();
    if(button){
      this.FDK_buffer = button;
      return state.FDK_next_state;
    }
  }

  /**
   * [processStateBeginICCInit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateBeginICCInit = function(state){
    return state.icc_init_not_started_next_state;
  }

  /**
   * [processState description]
   * @param  {[type]} state_number [description]
   * @return {[type]}              [description]
   */
  this.processState = function(state_number){
    var state = this.states.get(state_number);
    var next_state = null;

    do{
      if(state){
        this.current_state = state;
        log.info('Processing state ' + state.number + state.type + ' (' + state.description + ')');
      }else
      {
        log.error('Error getting state ' + state_number + ': state not found');
        return false;
      }
        
      switch(state.type){
        case 'A':
          next_state = this.processStateA(state);
          break;

        case 'B':
          next_state = this.processStateB(state);
          break;

        case 'D':
          state.extension_state !== '255' ? next_state = this.processStateD(state, this.states.get(state.extension_state)) : next_state = this.processStateD(state);
          break;

        case 'K':
          next_state = this.processStateK(state);
          break;

        case 'X':
          next_state = this.processStateX(state);
          break;

        case 'Y':
          next_state = this.processStateY(state);
          break;

        case 'W':
          next_state = this.processStateW(state);
          break;

        case '+':
          next_state = this.processStateBeginICCInit(state);
          break;

        default:
          log.error('atm.processState(): unsupported state type ' + state.type);
          next_state = null;
      }

      if(next_state)
        state = this.states.get(next_state);
      else
        break;

    }while(state);

    return true;
  }

  /**
   * [parseTrack2 parse track2 and return card object]
   * @param  {[type]} track2 [track2 string]
   * @return {[card object]} [description]
   */
  this.parseTrack2 = function(track2){
    var card = {};
    try{
      var splitted = track2.split('=')
      card.track2 = track2;
      card.number = splitted[0].replace(';', '');
      card.service_code = splitted[1].substr(4, 3);
    }catch(e){
      log.info(e);
      return null;
    }

    return card;
  }

  this.readCard = function(cardnumber, track2_data){
    var track2 = cardnumber + '=' + track2_data;

    this.card = this.parseTrack2(track2)
    if(this.card){
      log.info('Card ' + this.card.number + ' read');
      this.processState('000');
    }
  }

  this.trace = new Trace();
  this.states = new StatesService(settings, log);
  this.screens = new ScreensService(settings, log);
  this.FITs = new FITsService(settings, log);

  this.status = 'Offline';
  this.initBuffers();
  this.current_screen = {};
  this.current_state = {};
  this.buttons_pressed = [];
}

/**
 * [processFDKButtonPressed description]
 * @param  {[type]} button [description]
 * @return {[type]}        [description]
 */
ATM.prototype.processFDKButtonPressed = function(button){
  log.info(button + ' button pressed');
  this.buttons_pressed.push(button);
  this.processState(this.current_state.number)
};


/**
 * [processPinpadButtonPressed description]
 * @param  {[type]} button [description]
 * @return {[type]}        [description]
 */
ATM.prototype.processPinpadButtonPressed = function(button){
  //log.info('Button ' + button + 'pressed');
  switch(this.current_state.type){
    case 'B':
      this.PIN_buffer += button;
      //log.info(this.PIN_buffer);
      if(this.PIN_buffer.length == this.max_pin_length)
        this.processState(this.current_state.number)
      break;

    default:
      log.error('No keyboard entry allowed for state type ' + this.current_state.type);
      break;
  }
};

/**
 * [processHostMessage description]
 * @param  {[type]} data [description]
 * @return {[type]}      [description]
 */
ATM.prototype.processHostMessage = function(data){
  switch(data.message_class){
    case 'Terminal Command':
      return this.processTerminalCommand(data);

    case 'Data Command':
      return this.processDataCommand(data);

    case 'Transaction Reply Command':
      return this.processTransactionReply(data);
            
    default:
      log.info('ATM.processHostMessage(): unknown message class: ' + data.message_class);
      break;
  }
  return false;
};

module.exports = ATM;
