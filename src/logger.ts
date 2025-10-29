
export  const logger = (...argv: any ) => {
    const date = new Date ()
    const dateStrang = `%c [worker INFO ${ date.getHours() }:${ date.getMinutes() }:${ date.getSeconds() }:${ date.getMilliseconds ()}]`
    return console.log ( dateStrang, 'color: #6f4de7ff',  ...argv)
}

