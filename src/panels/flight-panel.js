import {getTimeString} from '../helpers/helpers';
import Panel from './panel';

export default class extends Panel {

    constructor(options) {
        super(Object.assign({className: 'flight-panel'}, options));
    }

    addTo(map) {
        const me = this,
            flight = me._options.object;

        me.updateHeader();
        me.setHTML(map.getFlightDescription(flight));

        return super.addTo(map);
    }

    updateHeader() {
        const me = this,
            flight = me._options.object,
            {a: airline, n: flightNumber} = flight,
            map = me._map;

        const title = airline && map
            ? map.getLocalizedOperatorTitle(airline)
            : (Array.isArray(flightNumber) ? flightNumber[0] : String(flightNumber || ''));

        me.setTitle(title);
    }

    updateContent() {
        const me = this,
            flight = me._options.object,
            map = me._map;

        if (map) {
            me.setHTML(map.getFlightDescription(flight));
        }
    }

}
